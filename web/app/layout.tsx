import type { Metadata } from "next";
import { IBM_Plex_Mono, Noto_Sans_Thai } from "next/font/google";
import { ToastProvider } from "@/components/Toasts";
import "./prototype.css";
import "./globals.css";

const notoThai = Noto_Sans_Thai({ variable: "--font-noto-thai", subsets: ["thai", "latin"], weight: ["400", "500", "600", "700"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Transcripto",
  description: "ถอดเสียงวิดีโอเป็นข้อความ แยกผู้พูด และสรุปการประชุม",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="th" data-style="minimal" className={`${notoThai.variable} ${plexMono.variable}`}>
      <body>
        <a className="skip" href="#main">
          ข้ามไปเนื้อหาหลัก
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
