// Nạp apps/api/.env trước mọi import khác (decorator của gateway đọc env lúc load module).
// Production (Render) cấp biến môi trường trực tiếp nên không cần file.
try {
  process.loadEnvFile();
} catch {
  /* không có .env — dùng biến môi trường của nền tảng */
}
