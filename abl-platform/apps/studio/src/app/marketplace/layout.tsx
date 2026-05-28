import { MarketplaceLayout } from '@/components/marketplace/MarketplaceLayout';

export default function MarketplaceRootLayout({ children }: { children: React.ReactNode }) {
  return <MarketplaceLayout>{children}</MarketplaceLayout>;
}
