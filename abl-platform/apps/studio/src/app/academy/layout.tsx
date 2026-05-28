import { AcademyLayout } from '@/components/academy/AcademyLayout';

export default function AcademyRootLayout({ children }: { children: React.ReactNode }) {
  return <AcademyLayout>{children}</AcademyLayout>;
}
