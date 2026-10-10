import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { vi } from './vi';

const saved = (() => {
  try {
    return localStorage.getItem('wt.lang');
  } catch {
    return null;
  }
})();

// Mặc định tiếng Anh để giao diện demo khớp video tham chiếu (đổi DEC-47 theo yêu cầu chủ dự án); tiếng Việt chọn trong menu
void i18n.use(initReactI18next).init({
  resources: { vi: { translation: vi }, en: { translation: en } },
  lng: saved === 'vi' ? 'vi' : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lng: 'vi' | 'en') {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem('wt.lang', lng);
  } catch {
    /* bỏ qua */
  }
}

export default i18n;
