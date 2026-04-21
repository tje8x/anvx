import { UserButton } from "@clerk/nextjs";

export function Header() {
  return (
    <header className="flex items-center justify-between border-b px-6 py-3">
      <span className="text-lg font-semibold">anvx</span>
      <UserButton />
    </header>
  );
}
