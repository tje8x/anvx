import type { Config } from "tailwindcss";

const config: Config = {
    darkMode: ["class"],
    content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
  	extend: {
  		colors: {
            anvx: {
                bg: 'var(--anvx-bg)',
                win: 'var(--anvx-win)',
                bdr: 'var(--anvx-bdr)',
                acc: 'var(--anvx-acc)',
                'acc-light': 'var(--anvx-acc-light)',
                danger: 'var(--anvx-danger)',
                'danger-light': 'var(--anvx-danger-light)',
                warn: 'var(--anvx-warn)',
                'warn-light': 'var(--anvx-warn-light)',
                info: 'var(--anvx-info)',
                'info-light': 'var(--anvx-info-light)',
                text: 'var(--anvx-text)',
                'text-dim': 'var(--anvx-text-dim)',
            },
        },
        fontFamily: {
            ui: ['var(--font-ui)', 'monospace'],
            data: ['var(--font-data)', 'monospace'],
        },
  	}
  },
  plugins: [require("tailwindcss-animate")],
};
export default config;
