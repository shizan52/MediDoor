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
      // Used by the splash + button-tap microinteractions.
      keyframes: {
        pop: {
          "0%": { transform: "scale(0.96)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(16px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
      },
      animation: {
        pop: "pop 200ms cubic-bezier(0.2, 0.8, 0.2, 1.0)",
        slideUp: "slideUp 240ms cubic-bezier(0.2, 0.8, 0.2, 1.0)",
      },
    },
  },
  plugins: [],
};
