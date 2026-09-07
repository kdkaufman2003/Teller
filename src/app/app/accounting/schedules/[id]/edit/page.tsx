import { ScheduleComposer } from "@/components/ScheduleComposer";

type PageProps = { params: Promise<{ id: string }> };

export default async function EditSchedulePage({ params }: PageProps) {
  const { id } = await params;
  return <ScheduleComposer editScheduleId={id} />;
}
