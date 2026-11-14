export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        brand: {
          primary: '#0B5FFF',
          hover:   '#0848CC',
          ring:    'rgba(11,95,255,0.15)',
        },
        navy: {
          900: '#0B1B3A',
          800: '#102346',
        },
        tok: {
          success: '#12B76A',
          danger:  '#F04438',
          warning: '#F79009',
          'page-bg': '#F7F9FC',
          border:  '#E2E8F0',
        },
      },
      borderRadius: {
        input: '10px',
        card:  '16px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,.05), 0 12px 32px rgba(16,24,40,.08)',
        'card-sm': '0 1px 2px rgba(16,24,40,.06)',
      },
      letterSpacing: {
        tightest: '-0.02em',
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [],
}
