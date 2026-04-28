"use client";

import { ReactNode, useState } from "react";
import WaitlistModal from "./WaitlistModal";

export default function WaitlistButton({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children}
      </button>
      <WaitlistModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
