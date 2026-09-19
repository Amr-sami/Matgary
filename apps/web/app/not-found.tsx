import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import { NotFoundIllustration } from "@/components/feedback/illustrations";

export default function NotFound() {
  return (
    <ErrorScreen
      illustration={<NotFoundIllustration />}
      title="الصفحة غير موجودة"
      description="الرابط الذي تحاول الوصول إليه قد تم نقله أو حذفه. تأكد من العنوان أو ارجع للصفحة الرئيسية."
      actions={
        <>
          <Link href="/">
            <Button className="w-full sm:w-auto">العودة للرئيسية</Button>
          </Link>
        </>
      }
    />
  );
}
