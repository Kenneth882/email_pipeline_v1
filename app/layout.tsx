import type { ReactNode } from "react";

export const metadata = {
  title: "VenueHopper Email Pipeline",
  description: "Inbound Gmail webhook for VenueHopper Phase 2",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
