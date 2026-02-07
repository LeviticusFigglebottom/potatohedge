import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Optix — Options Analytics Dashboard',
  description: 'Self-hosted options flow, dealer positioning, and market analytics',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg-primary text-text-primary antialiased">
        {children}
      </body>
    </html>
  );
}
