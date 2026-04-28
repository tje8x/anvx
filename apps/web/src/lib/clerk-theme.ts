import type { Appearance } from "@clerk/types";

export const anvxClerkAppearance: Appearance = {
  elements: {
    rootBox: "w-full max-w-md",
    card: "bg-[#f5f3ed] border border-[#8e8a7e] rounded-lg shadow-lg",
    headerTitle: "font-mono text-[#2c2a25]",
    headerSubtitle: "font-mono text-[#6b675e]",
    formButtonPrimary:
      "bg-[#2d5a27] hover:bg-[#1e3d1a] text-white font-mono uppercase tracking-wider text-xs",
    formFieldInput:
      "border-[#8e8a7e] bg-[#f5f3ed] font-mono text-[#2c2a25] focus:border-[#2d5a27] focus:ring-[#2d5a27]",
    formFieldLabel: "font-mono text-[#2c2a25] text-xs uppercase tracking-wider",
    footerActionLink: "text-[#2d5a27] font-mono",
    socialButtonsBlockButton:
      "border-[#8e8a7e] bg-[#f5f3ed] font-mono text-[#2c2a25] hover:bg-[#e8e4d9]",
    dividerLine: "bg-[#8e8a7e]",
    dividerText: "font-mono text-[#6b675e]",
    footer: "font-mono",
  },
  layout: {
    socialButtonsPlacement: "top",
    showOptionalFields: false,
  },
};
