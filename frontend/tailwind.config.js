/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#e6fbf3",
          100: "#c2f4dd",
          200: "#8feac1",
          300: "#52dba0",
          400: "#1ec77f",
          500: "#06ad65",
          600: "#008c52",
          700: "#006e41",
          800: "#005232",
          900: "#003a24",
          950: "#001f13",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      animation: {
        "blob": "blob 12s infinite",
        "float": "float 6s ease-in-out infinite",
      },
      keyframes: {
        blob: {
          "0%, 100%": { transform: "translate(0,0) scale(1)" },
          "33%":      { transform: "translate(30px,-40px) scale(1.1)" },
          "66%":      { transform: "translate(-20px,20px) scale(0.95)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%":      { transform: "translateY(-12px)" },
        },
      },
    },
  },
  plugins: [],
};
