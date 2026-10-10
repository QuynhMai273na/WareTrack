/** Biểu tượng hàng hóa như video: thùng carton, thùng nhựa xanh, mũ bảo hộ, cuộn băng keo, chai nước… */
export function SkuIcon({ code, size = 22 }: { code: string; size?: number }) {
  const c = code.toUpperCase();
  if (c.includes('HLM')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <path fill="#f6a623" d="M5 21c0-7 5-12 11-12s11 5 11 12z" />
        <path fill="#f9c04f" d="M9 20c0-5 3-9 7-9s7 4 7 9z" />
        <rect x="3" y="20" width="26" height="4" rx="2" fill="#e08e0b" />
      </svg>
    );
  }
  if (c.includes('TAPE')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <ellipse cx="16" cy="18" rx="11" ry="9" fill="#d9a86c" />
        <ellipse cx="16" cy="15" rx="11" ry="9" fill="#e7c08e" />
        <ellipse cx="16" cy="15" rx="5" ry="4" fill="#ffffff" />
      </svg>
    );
  }
  if (c.includes('CONT') || c.includes('GLV')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <path fill="#2f6fe4" d="M4 10h24l-2 16H6z" />
        <path fill="#5b8ff0" d="M3 7h26v4H3z" />
        <path fill="#1f4fb8" d="M9 14h14v2H9z" />
      </svg>
    );
  }
  if (c.includes('WATER') || c.includes('JUICE')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <path fill="#dfe6f3" d="M5 12h22v14H5z" />
        <path fill="#b9c6e0" d="M5 12l3-4h16l3 4z" />
        <path fill="#7fa3e8" d="M8 15h4v8H8zm6 0h4v8h-4zm6 0h4v8h-4z" />
      </svg>
    );
  }
  if (c.includes('PEAS') || c.includes('BERRY') || c.startsWith('FRZ')) {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <path fill="#e9eef7" d="M6 8h20l-2 18H8z" />
        <path fill="#7fbf7f" d="M11 15a2 2 0 1 0 0.01 0zm5 2a2 2 0 1 0 .01 0zm5-2a2 2 0 1 0 .01 0z" />
        <path fill="#b8c4dc" d="M6 8h20v3H6z" />
      </svg>
    );
  }
  // Carton mặc định
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path fill="#d9a86c" d="M16 4 28 10v13L16 29 4 23V10z" />
      <path fill="#e8c193" d="M16 4 28 10 16 16 4 10z" />
      <path fill="#c48d4f" d="M16 16v13l12-6V10z" />
      <path fill="#f4dcb8" d="M10 7l12 6v3l-12-6z" />
    </svg>
  );
}
