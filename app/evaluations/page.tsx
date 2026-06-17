import { redirect } from 'next/navigation';
import { defaultProjectId } from '@/lib/mock-data/projects';

export default function EvaluationsRedirectPage() {
  redirect(`/projects/${defaultProjectId}/evaluations`);
}
