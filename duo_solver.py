#!/usr/bin/env python3
"""
Duolingo Automated Lesson Solver (Safe Mode)
Zero external dependencies - pure Python stdlib.
"""

import argparse
import base64
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)

# Dinleme ve konuşma soruları tamamen çıkarıldı (sadece metin/çeviri/seçim)
CHALLENGE_TYPES = [
    "assist", "characterIntro", "characterMatch", "characterPuzzle",
    "characterSelect", "characterTrace", "characterWrite",
    "completeReverseTranslation", "definition", "dialogue", "extendedMatch",
    "form", "freeResponse", "gapFill", "judge", "match", "name",
    "orderTapComplete", "partialReverseTranslate", "patternTapComplete",
    "radioBinary", "radioImageSelect", "radioSelect", "readComprehension",
    "reverseAssist", "sameDifferent", "select", "selectTranscription",
    "svgPuzzle", "syllableTap", "tapCloze", "tapClozeTable", "tapComplete",
    "tapCompleteTable", "tapDescribe", "translate", "transliterate",
    "transliterationAssist", "typeCloze", "typeClozeTable", "typeComplete",
    "typeCompleteTable", "writeComprehension",
]


class DuolingoBot:
    def __init__(self, token: str, delay: int = 60, mode: str = "path"):
        self.token = token.strip().replace("Bearer ", "").replace("jwt_token=", "")
        self.target_delay = max(5, delay)
        self.mode = mode
        self.user_id = self._extract_user_id()
        self.headers = {
            "Authorization": f"Bearer {self.token}",
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json; charset=UTF-8",
            "Origin": "https://www.duolingo.com",
            "Referer": "https://www.duolingo.com/learn",
        }

    def _extract_user_id(self) -> str:
        try:
            parts = self.token.split(".")
            if len(parts) < 2:
                raise ValueError("Geçersiz JWT token formatı.")
            payload_b64 = parts[1]
            padded = payload_b64 + "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
            sub = str(payload.get("sub", ""))
            if not sub:
                raise ValueError("Token içinde 'sub' (User ID) bulunamadı.")
            return sub
        except Exception as e:
            print(f"[!] Token çözümlenemedi: {e}")
            sys.exit(1)

    def _api_request(self, method: str, url: str, data: dict = None, extra_headers: dict = None) -> dict:
        headers = dict(self.headers)
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, headers=headers, method=method)
        body = json.dumps(data).encode("utf-8") if data is not None else None

        try:
            with urllib.request.urlopen(req, data=body, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            if e.code == 401:
                print("\n[!] 401 Unauthorized: JWT token süresi dolmuş veya geçersiz.")
            elif e.code == 429:
                print("\n[!] 429 Too Many Requests: Rate limite takıldınız. Bekleniyor...")
            else:
                print(f"\n[!] HTTP {e.code} Hatası: {e.reason} -> {err_body[:200]}")
            raise e

    def get_user_profile(self) -> dict:
        fields = "currentCourse,fromLanguage,learningLanguage,streak,totalXp,username"
        # 2017-06-30 endpointi patika (pathSectioned) ve beceri ağacını içerir
        url_2017 = f"https://www.duolingo.com/2017-06-30/users/{self.user_id}?fields={fields}"
        try:
            data = self._api_request("GET", url_2017)
            if data and data.get("currentCourse"):
                return data
        except Exception:
            pass

        # Alternatif: düz users endpointi
        try:
            data = self._api_request("GET", f"https://www.duolingo.com/users/{self.user_id}")
            if data and data.get("currentCourse"):
                return data
        except Exception:
            pass

        # 2023 fallback
        return self._api_request("GET", f"https://www.duolingo.com/2023-05-23/users/{self.user_id}")

    @staticmethod
    def _flatten_skills(raw_skills) -> list:
        flat = []
        if not raw_skills:
            return flat
        for item in raw_skills:
            if isinstance(item, list):
                flat.extend(DuolingoBot._flatten_skills(item))
            elif isinstance(item, dict):
                flat.append(item)
        return flat

    def _find_active_skill(self, profile: dict) -> dict:
        course = profile.get("currentCourse", {})
        sections = course.get("pathSectioned") or profile.get("pathSectioned", [])
        COMPLETED_STATES = {"completed", "passed", "legendary", "perfect", "locked"}

        if sections:
            for s_idx, section in enumerate(sections):
                s_num = s_idx + 1
                units = section.get("units", [])
                for u_idx, unit in enumerate(units):
                    u_num = u_idx + 1
                    unit_title = unit.get("teachingObjective") or unit.get("title") or f"{u_num}. Ünite"
                    levels = unit.get("levels", [])
                    for l_idx, level in enumerate(levels):
                        finished = level.get("finishedSessions", 0)
                        total = level.get("totalSessions", 1)
                        state = str(level.get("state", "")).lower()
                        level_type = level.get("type", "skill")

                        # Aktif veya henüz tamamlanmamış (ve kilitli/geçilmiş olmayan) ders
                        is_active = state in ("active", "started")
                        is_incomplete = state not in COMPLETED_STATES and finished < total

                        if is_active or is_incomplete:
                            client_data = level.get("pathLevelClientData", {})
                            meta_data = level.get("pathLevelMetadata", {})
                            skill_id = (
                                client_data.get("skillId")
                                or (client_data.get("skillIds") or [None])[0]
                                or meta_data.get("anchorSkillId")
                            )

                            title = f"Kısım {s_num}, Ünite {u_num} (\"{unit_title}\"), Seviye {l_idx+1} ({level_type.upper()}, {finished+1}/{total}. ders)"
                            if skill_id:
                                return {
                                    "skillId": skill_id,
                                    "levelIndex": level.get("levelIndex", 0),
                                    "levelSessionIndex": finished,
                                    "type": level_type,
                                    "title": title,
                                    "section": s_num,
                                    "unit": u_num,
                                    "unitTitle": unit_title,
                                    "levelNum": l_idx + 1,
                                    "finished": finished,
                                    "total": total,
                                }

        # 2. Klasik Skills ağacı fallback
        skills = self._flatten_skills(course.get("skills", []))
        if skills:
            for skill in skills:
                finished_levels = skill.get("finishedLevels", 0)
                levels = skill.get("levels", 1)
                finished_lessons = skill.get("finishedLessons", 0)
                total_lessons = skill.get("lessons", 1)
                if finished_levels < levels or finished_lessons < total_lessons:
                    name = skill.get("name", skill.get("id"))
                    return {
                        "skillId": skill.get("id"),
                        "levelIndex": finished_levels,
                        "levelSessionIndex": finished_lessons,
                        "type": "skill",
                        "title": f"Beceri: {name} ({finished_lessons+1}/{total_lessons}. ders)",
                    }

        print(f"[!] currentCourse içinde harita düğümü çözümlenemedi. (Anahtarlar: {list(course.keys())})")
        return None

    def start_session(self, learn_lang: str, from_lang: str, skill_info: dict = None) -> dict:
        url = "https://www.duolingo.com/2017-06-30/sessions"

        # Eğer path modundaysa ve skill bilgisi varsa doğrudan LESSON olarak başlat
        if self.mode == "path" and skill_info:
            print(f"[*] Patika oturumu başlatılıyor -> {skill_info.get('title')}")
            payload = {
                "challengeTypes": CHALLENGE_TYPES,
                "disableListening": True,
                "disableSpeaking": True,
                "fromLanguage": from_lang,
                "isFeedbackUpdateEnabled": True,
                "isFinalLevel": False,
                "isV2": True,
                "juicy": True,
                "learningLanguage": learn_lang,
                "smartStreakCohort": "ACTIVE",
                "type": "LESSON",
                "skillId": skill_info["skillId"],
                "levelIndex": skill_info.get("levelIndex", 0),
                "levelSessionIndex": skill_info.get("levelSessionIndex", 0),
            }
            try:
                return self._api_request("POST", url, payload)
            except urllib.error.HTTPError as e:
                print(f"[!] Patika dersi {e.code} verdi. Güvenli pratik moduna geçiliyor...")

        # Fallback: GLOBAL_PRACTICE
        payload = {
            "challengeTypes": CHALLENGE_TYPES,
            "disableListening": True,
            "disableSpeaking": True,
            "fromLanguage": from_lang,
            "isFeedbackUpdateEnabled": True,
            "isFinalLevel": False,
            "isV2": True,
            "juicy": True,
            "learningLanguage": learn_lang,
            "smartStreakCohort": "ACTIVE",
            "type": "GLOBAL_PRACTICE",
        }
        return self._api_request("POST", url, payload)

    def submit_session(self, session: dict, start_time: int, end_time: int) -> dict:
        session_id = session.get("id")
        url = f"https://www.duolingo.com/2017-06-30/sessions/{session_id}"
        challenges = session.get("challenges", [])
        num_challenges = len(challenges)

        time_per_q = max(2, (end_time - start_time) // max(1, num_challenges))
        challenge_times = {c.get("id"): time_per_q for c in challenges if "id" in c}

        payload = dict(session)
        tracking = payload.setdefault("trackingProperties", {})
        tracking["sum_time_taken"] = end_time - start_time
        tracking["xp_gained"] = 15

        payload.update({
            "heartsLeft": 5,
            "startTime": start_time,
            "endTime": end_time,
            "failed": False,
            "maxInLessonStreak": num_challenges,
            "shouldLearnGems": True,
            "hasBoost": True,
            "xpGain": 15,
            "challengeTimes": challenge_times,
        })

        extra_headers = {
            "Idempotency-Key": str(session_id),
            "X-Requested-With": "XMLHttpRequest",
            "User": str(self.user_id),
            "Referer": "https://www.duolingo.com/lesson",
        }

        return self._api_request("PUT", url, payload, extra_headers=extra_headers)

    def show_status(self):
        print("[-] Profil ve harita verileri çekiliyor...")
        profile = self.get_user_profile()

        username = profile.get("username", "Bilinmeyen")
        streak = profile.get("streak", 0)
        total_xp = profile.get("totalXp", 0)
        gems = profile.get("gems") or profile.get("lingots", 0)
        from_lang = profile.get("fromLanguage", "tr")
        learn_lang = profile.get("learningLanguage", "en")
        course = profile.get("currentCourse", {})
        if course:
            from_lang = course.get("fromLanguage", from_lang)
            learn_lang = course.get("learningLanguage", learn_lang)

        flat_skills = self._flatten_skills(course.get("skills", []))
        skill_names = {s.get("id"): (s.get("name") or s.get("title") or "") for s in flat_skills if isinstance(s, dict)}
        sections = course.get("pathSectioned") or profile.get("pathSectioned", [])

        print("\n" + "=" * 55)
        print("         DUOLINGO GÜNCEL İLERLEME RAPORU")
        print("=" * 55)
        print(f"Kullanıcı    : {username} (ID: {self.user_id})")
        print(f"Seri (Streak): {streak} gün | Toplam XP: {total_xp} | Mücevher: {gems}")
        print(f"Aktif Dil    : {from_lang.upper()} -> {learn_lang.upper()}")
        print("-" * 55)

        if not sections:
            print("[!] Harita (pathSectioned) verisi boş geldi.")
            skills = course.get("skills", [])
            print(f"[*] Klasik beceri listesi: {len(skills)} konu mevcut.")
            print("=" * 55 + "\n")
            return

        print(f"Harita Kapsamı: Toplam {len(sections)} Kısım (Section) mevcut.")

        active_found = False
        COMPLETED_STATES = {"completed", "passed", "legendary", "perfect", "locked"}
        for s_idx, section in enumerate(sections):
            s_num = s_idx + 1
            units = section.get("units", [])
            for u_idx, unit in enumerate(units):
                u_num = u_idx + 1
                unit_title = unit.get("teachingObjective") or unit.get("title") or f"{u_num}. Ünite"
                levels = unit.get("levels", [])

                for l_idx, level in enumerate(levels):
                    finished = level.get("finishedSessions", 0)
                    total = level.get("totalSessions", 1)
                    state = str(level.get("state", "")).lower()
                    level_type = level.get("type", "skill")

                    is_active = state in ("active", "started")
                    is_incomplete = state not in COMPLETED_STATES and finished < total

                    if is_active or is_incomplete:
                        client_data = level.get("pathLevelClientData", {})
                        meta_data = level.get("pathLevelMetadata", {})
                        skill_id = (
                            client_data.get("skillId")
                            or (client_data.get("skillIds") or [None])[0]
                            or meta_data.get("anchorSkillId")
                        )
                        skill_name = skill_names.get(skill_id, "Genel Alıştırma")

                        print(f"Aktif Konum  : {s_num}. Kısım | {u_num}. Ünite")
                        print(f"Ünite Konusu : \"{unit_title}\"")
                        print(f"Seviye/Düğüm : {l_idx + 1} / {len(levels)} (Tip: {level_type.upper()})")
                        print(f"Sıradaki Ders: {finished + 1} / {total} (Tamamlanan: {finished})")
                        print(f"Konu Başlığı : {skill_name} (Skill ID: {skill_id})")
                        print(f"Düğüm Durumu : {state.upper()}")
                        active_found = True
                        break
                if active_found:
                    break
            if active_found:
                break

        if not active_found:
            print("[*] Tüm açık üniteler tamamlanmış görünüyor.")

        print("=" * 55 + "\n")

    def run(self, max_lessons: int = 5):
        print("[-] Profil bilgileri çekiliyor...")
        profile = self.get_user_profile()

        username = profile.get("username", "Bilinmeyen")
        streak = profile.get("streak", 0)
        total_xp = profile.get("totalXp", 0)
        from_lang = profile.get("fromLanguage", "en")
        learn_lang = profile.get("learningLanguage", "es")
        current_course = profile.get("currentCourse", {})
        if current_course:
            from_lang = current_course.get("fromLanguage", from_lang)
            learn_lang = current_course.get("learningLanguage", learn_lang)

        print(f"[+] Giriş Başarılı: {username} (ID: {self.user_id})")
        print(f"    Streak: {streak} gün | Toplam XP: {total_xp}")
        print(f"    Aktif Kurs: {from_lang} -> {learn_lang} | Mod: {self.mode.upper()}")
        print(f"    Hedef: {max_lessons} ders | Ortalama Süre: ~{self.target_delay}s/ders\n")

        skill_info = self._find_active_skill(profile) if self.mode == "path" else None
        if skill_info:
            print(f"[+] Sıradaki Skill ID tespit edildi: {skill_info['skillId']}")
        else:
            print("[*] Spesifik skill bulunamadı, Global Pratik modu devrede.")

        completed = 0
        while completed < max_lessons:
            lesson_no = completed + 1
            print(f"--- [Ders {lesson_no}/{max_lessons}] Başlatılıyor... ---")

            start_ts = int(time.time())
            try:
                session = self.start_session(learn_lang, from_lang, skill_info)
            except Exception as e:
                print(f"[!] Oturum açılamadı ({e}), 10s beklenip tekrar denenecek...")
                time.sleep(10)
                continue

            session_id = session.get("id")
            challenges = session.get("challenges", [])
            print(f"[+] Oturum alındı (ID: {session_id[:8]}... | {len(challenges)} soru)")

            # İnsan taklidi rastgele gecikme (hedef ± %15)
            jitter = random.randint(-int(self.target_delay * 0.15), int(self.target_delay * 0.15))
            wait_time = max(15, self.target_delay + jitter)

            print(f"[*] Simülasyon sürüyor: {wait_time} saniye bekleniyor...")
            for remaining in range(wait_time, 0, -1):
                mins, secs = divmod(remaining, 60)
                sys.stdout.write(f"\r    Kalan süre: {mins:02d}:{secs:02d} | İlerleme: [{'#' * (wait_time - remaining)}{'.' * remaining}]")
                sys.stdout.flush()
                time.sleep(1)
            sys.stdout.write("\r" + " " * 80 + "\r")

            end_ts = int(time.time())

            print("[-] Ders tamamlanıyor...")
            try:
                result = self.submit_session(session, start_ts, end_ts)
                xp_gained = result.get("xpGain", 0) or result.get("pointsGained", 15)
                completed += 1
                print(f"[OK] Ders {lesson_no} Tamamlandı! +{xp_gained} XP")
            except Exception as e:
                print(f"[X] Gönderim hatası: {e}")

            if completed < max_lessons:
                rest = random.randint(3, 6)
                print(f"[*] Sıradaki ders tespiti için profil yenileniyor ({rest}s)...\n")
                time.sleep(rest)
                profile = self.get_user_profile()
                skill_info = self._find_active_skill(profile) if self.mode == "path" else None

        print("\n==========================================")
        print(f"[✓] İşlem tamamlandı! Toplam {completed} ders başarıyla bitirildi.")
        print("==========================================")


TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".token")


def main():
    parser = argparse.ArgumentParser(description="Duolingo Safe Auto Solver")
    parser.add_argument("--token", "-t", help="Duolingo JWT Token (veya DUO_JWT env)", default=os.getenv("DUO_JWT"))
    parser.add_argument("--lessons", "-l", type=int, help="Çözülecek ders sayısı (Varsayılan: 5)", default=5)
    parser.add_argument("--delay", "-d", type=int, help="Ders başı bekleme süresi saniye (Varsayılan: 60)", default=60)
    parser.add_argument("--mode", "-m", choices=["path", "practice"], help="Mod: path (mevcut yol) veya practice (pratik)", default="path")
    parser.add_argument("--status", "--info", "-i", action="store_true", help="Ders çözmeden sadece mevcut konum/harita durumunu gösterir")

    args = parser.parse_args()

    token = args.token
    if not token and os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                saved = f.read().strip()
                if saved:
                    token = saved
                    print("[+] Kayıtlı token yüklendi (.token).")
        except Exception:
            pass

    if not token:
        print("Duolingo JWT Token girilmedi.")
        print("Tarayıcınızdan (duolingo.com) F12 -> Application -> Cookies -> 'jwt_token' değerini kopyalayın.")
        token = input("\nJWT Token yapıştırın: ").strip()
        if token:
            try:
                with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                    f.write(token)
                print("[+] Token '.token' dosyasına kaydedildi (bir daha sorulmayacak).")
            except Exception as e:
                print(f"[!] Token kaydedilemedi: {e}")

    if not token:
        print("[!] Token olmadan çalışamaz.")
        sys.exit(1)

    bot = DuolingoBot(token=token, delay=args.delay, mode=args.mode)
    if args.status:
        bot.show_status()
        return

    try:
        bot.run(max_lessons=args.lessons)
    except KeyboardInterrupt:
        print("\n\n[!] Kullanıcı tarafından durduruldu (Ctrl+C). Çıkılıyor.")
        sys.exit(0)


if __name__ == "__main__":
    main()
