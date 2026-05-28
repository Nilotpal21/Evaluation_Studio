import { BrowsePreviewPage } from '@/components/search-ai/browse-preview/BrowsePreviewPage';

type Props = { params: Promise<{ kbId: string }> };

export default async function BrowsePreviewRoute({ params }: Props) {
  const { kbId } = await params;
  return <BrowsePreviewPage kbId={kbId} />;
}
