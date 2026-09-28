import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Design My Room | Kanabco Custom",
  description: "Preview a Kanabco furniture concept in your own living room.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
