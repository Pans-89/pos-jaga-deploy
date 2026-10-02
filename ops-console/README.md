# Pos Jaga — aplikasi uji EasyPanel

Panel insiden kecil untuk menguji deploy aplikasi web + PostgreSQL di EasyPanel. Form membuat data sungguhan di database; tandai selesai untuk menambah jejak aktivitas. Data tidak di-seed otomatis agar nilai dashboard tidak menyamar sebagai data monitoring nyata.

## Deploy lewat EasyPanel

1. Masukkan folder **ops-console** ke repository Git yang bisa diakses VPS.
2. Di EasyPanel: **Project → New Service → Compose**. Pilih sumber Git.
3. Atur repository/branch, **Build Path /ops-console**, dan Compose file **compose.yaml**.
4. Di environment editor, isi **APP_PASSWORD** (minimal 16 karakter), **SECRET_KEY** dan **POSTGRES_PASSWORD** (masing-masing nilai acak yang berbeda, minimal 32 karakter), **POSTGRES_DB=opsconsole**, **POSTGRES_USER=opsconsole**, **SESSION_COOKIE_SECURE=true**. Buat tiga rahasia berbeda dengan menjalankan `openssl rand -hex 32` tiga kali di komputer sendiri; masukkan hasilnya langsung ke EasyPanel. Jangan gunakan nilai di .env.example sebagai rahasia.
5. Deploy. Compose menunggu database sehat sebelum memulai aplikasi.
6. Tambahkan domain lewat EasyPanel dan arahkan ke service internal **web** port **8000**. Aktifkan HTTPS. Database db tidak punya port publik.
7. Buka domain dan login memakai APP_PASSWORD.

EasyPanel mendukung Compose multi-container dan mengarahkan domain ke service internal. Compose ini menyediakan named volume **pgdata** agar data PostgreSQL tetap ada saat container dibuat ulang. Panduan resmi: https://easypanel.io/docs/services/compose.

## Tes yang membuktikan deployment

- **/health** → app menjawab.
- **/ready** → app dan koneksi database siap; status 503 jika database gagal.
- Login, buat catatan insiden, kemudian lihat daftar dan aktivitas.
- Restart/redeploy service, login lagi, pastikan catatan masih muncul.
- Uji tandai selesai, filter status, cari judul, dan lihat statistik berubah.
- Di EasyPanel lihat log service **web** dan **db**, serta status health container.

**Peringatan storage:** jangan menghapus volume **pgdata** atau menjalankan perintah down dengan flag **-v** jika ingin mempertahankan catatan. Named volume membuat data bertahan pada redeploy; bukan backup. Siapkan backup terpisah sebelum menyimpan data penting.

## Beban resource dan batas

Compose membatasi app pada 256 MiB RAM / 0.5 CPU dan PostgreSQL pada 320 MiB / 0.75 CPU. PostgreSQL memakai 64 MiB shared buffers dan maksimum 30 koneksi. Batas container bukan prediksi penggunaan pasti; pantau docker stats dan Grafana setelah deploy karena VPS 2 GiB sudah menjalankan service lain. Jika RAM tersedia terus turun atau mulai swap berat, stop aplikasi uji dan kurangi worker/limit sebelum lanjut.

Ini workload latihan: satu password operator, tanpa role multi-user, pemulihan bencana, atau kontrol audit produksi. Jangan masukkan data pribadi/rahasia. Rotasi password memerlukan sinkronisasi password aplikasi dan konfigurasi database; mengubah environment POSTGRES_PASSWORD saja tidak mengubah password pada volume database yang sudah diinisialisasi.
