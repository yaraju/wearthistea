import type { Metadata } from "next";
import { Libre_Bodoni, Public_Sans, Space_Mono } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";

const display = Libre_Bodoni({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const sans = Public_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

const mono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "wearthistea — wear the tea before it cools",
  description:
    "Spill a piece of internet drama. Our AI turns it into original t-shirt designs in seconds. Pick your favorite, we print it. Gossip you can wear.",
  openGraph: {
    title: "wearthistea — wear the tea before it cools",
    description:
      "Type the drama. Get 5 AI-designed tees. Spill the tea, wear the tea.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-paper text-ink font-sans selection:bg-pink selection:text-paper">
        {children}
      </body>
      {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
        <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID} />
      )}
    </html>
  );
}
