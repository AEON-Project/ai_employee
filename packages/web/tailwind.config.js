/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#f8fafc',
        card: '#ffffff',
        border: '#e2e8f0',
        accent: '#6366f1',
        muted: '#64748b',
      },
    },
  },
  plugins: [],
}
