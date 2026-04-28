import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ANVX — Financial Autopilot for AI-native companies",
  description: "Route AI traffic intelligently. Prevent cost disasters. Make spend accountant-ready.",
  openGraph: {
    title: "ANVX — Financial Autopilot for AI-native companies",
    description: "Route AI traffic intelligently. Prevent cost disasters. Make spend accountant-ready.",
    images: ["/og.png"],
  },
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="anvx-marketing min-h-screen scroll-smooth bg-[var(--anvx-bg)] text-[var(--anvx-text)]">
      {children}
    </div>
  );
}
