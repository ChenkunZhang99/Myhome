import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSettingsProvider } from "./AppSettings";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "家里有数｜家庭库存与采购助手",
    description: "查看家庭库存、临期提醒、Flyer 优惠窗口与采购预算。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "家里有数",
      description: "家庭库存、Flyer 优惠与采购计划，都在一处。",
      type: "website",
      images: [{ url: imageUrl, width: 1728, height: 901, alt: "家里有数家庭库存助手" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "家里有数",
      description: "家庭库存、Flyer 优惠与采购计划，都在一处。",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // AppSettingsProvider 会在客户端按存储的偏好改写 lang。
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <AppSettingsProvider>{children}</AppSettingsProvider>
      </body>
    </html>
  );
}
