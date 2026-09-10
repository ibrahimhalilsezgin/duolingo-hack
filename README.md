# DuoBot: Duolingo Otopilot & Akıllı Soru Çözücü

Duolingo web sürümünde dersleri çözen, harita düğümlerini (Snake Path) ilerleten ve can koruması sağlayan hibrit otomasyon paketi.

## Bileşenler

| Dosya | Açıklama |
| --- | --- |
| `duo_autoclicker_v11.user.js` | Tarayıcıda tam otopilot çalışan Tampermonkey kullanıcı betiği. |
| `duo_solver.py` | Python stdlib tabanlı oturum çözücü ve hızlı can yenileme aracı. |
| `.token` | Python betiği için saklanan Duolingo `jwt_token`. |

---

## Mimari & Çözüm Akışı

1. **0ms Yerel React Fiber Doğrulaması:**
   - Ekrana gelen soru öncelikle React dahili Fiber nesnesinden taranır (`displayTokens`, `correctSolutions`, `correctTokens`).
   - Veri varsa ağ isteği atılmadan anında doğru şık işaretlenir veya kelimeler dizilir.

2. **Gemini 3.6 Flash Hibrit AI Fallback:**
   - Fiber'da net cevap yoksa soru tipi sınıflandırılır:
     - **Eksik Sözcük:** Cümlenin tamamı yerine yalnızca boşluğa gelen eksik kelimeyi yazar (`month`).
     - **Tırnak İçi Kelime:** İstenen hedef kelimeyi doğrudan çevirir (`movie`).
     - **Tam Cümle:** Cümleyi hedef dile çevirir; sonundaki nokta (`.`) işaretini korur.
     - **Çoktan Seçmeli:** Şık rozetlerini (`1\n`) ayıklayıp doğru metni tıklar.
     - **Kelime Bankası / Boşluk Doldurma:** Noktalama taşları dahil sırayla butonlara tıklar.

3. **Can (Hearts) Koruması & Arka Plan Pratik:**
   - Ders sırasında can `≤ 1` olduğunda veya haritada can `≤ 2` olduğunda devreye girer.
   - Dersi terk etmeden arka planda `POST/PUT /2017-06-30/sessions` (`GLOBAL_PRACTICE`) çağrısı yapar.
   - Canı 5'e tamamlar ve dersi kaldığı yerden çözmeye devam eder.

4. **Kalıcı Otopilot (`localStorage`):**
   - Panelden `AÇIK 🚀` yapıldığında durum kaydedilir. Sayfa yenilense veya haritaya dönse de açık kalır.
   - `/learn` haritasında aktif düğümü bulur, "BAŞLAT" butonuna tıklar ve sıradaki derse girer.

---

## Kurulum (Tampermonkey)

1. Tarayıcıya [Tampermonkey](https://www.tampermonkey.net/) uzantısını kur.
2. Tampermonkey panosundan **Yeni Betik Ekle** seçeneğine tıkla.
3. `duo_autoclicker_v11.user.js` dosyasının içeriğini yapıştır ve `Ctrl+S` ile kaydet.
4. `https://www.duolingo.com/learn` sayfasını aç.
5. Sağ altta beliren **Ders Çözücü v11: KAPALI ⏸️** paneline tıklayarak `AÇIK 🚀` moduna al.

---

## CLI Kullanımı (`duo_solver.py`)

Harici kütüphane gerektirmez (pure Python stdlib).

### 1. Token Tanımlama
Tarayıcıda Duolingo açıkken `F12 -> Application -> Cookies -> jwt_token` değerini al.
Betiği ilk çalıştırdığında token sorar ve `.token` dosyasına yazar:
```bash
python duo_solver.py --status
```

### 2. Can Doldurma (Practice Modu)
Arka planda 5 ders pratik çözerek canları hızlıca fuller:
```bash
python duo_solver.py --mode practice --lessons 5 --delay 5
```

### 3. Komut Satırı Parametreleri
- `--mode`, `-m`: `path` (patika dersi) veya `practice` (genel pratik).
- `--lessons`, `-l`: Çözülecek ders sayısı (Varsayılan: `5`).
- `--delay`, `-d`: Ders tamamlama simülasyon gecikmesi saniye cinsinden (Varsayılan: `60`).
- `--status`, `-i`: Ders çözmeden profil, streak ve harita durumunu gösterir.
