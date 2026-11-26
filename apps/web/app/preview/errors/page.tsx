"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import {
  NotFoundIllustration,
  ErrorIllustration,
  ForbiddenIllustration,
  OfflineIllustration,
  EmptyIllustration,
} from "@/components/feedback/illustrations";

const Section = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <section className="border-t border-border">
    <div className="px-4 sm:px-6 py-3 bg-bg-main text-xs font-mono uppercase tracking-wider text-text-secondary">
      {label}
    </div>
    {children}
  </section>
);

export default function ErrorsPreview() {
  return (
    <div className="min-h-screen bg-white">
      <header className="px-4 sm:px-6 py-4 border-b border-border">
        <h1 className="font-display font-extrabold text-xl text-text-primary">
          معاينة شاشات الأخطاء
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          صفحة استعراض داخلية — لا تظهر للمستخدم النهائي.
        </p>
      </header>

      <Section label="404 — الصفحة غير موجودة">
        <ErrorScreen
          illustration={<NotFoundIllustration />}
          title="الصفحة غير موجودة"
          description="الرابط الذي تحاول الوصول إليه قد تم نقله أو حذفه. تأكد من العنوان أو ارجع للصفحة الرئيسية."
          actions={
            <Link href="/">
              <Button className="w-full sm:w-auto">العودة للرئيسية</Button>
            </Link>
          }
        />
      </Section>

      <Section label="App Error — خطأ غير متوقع">
        <ErrorScreen
          illustration={<ErrorIllustration />}
          title="حدث خطأ غير متوقع"
          description="نأسف للإزعاج — حدث خطأ أثناء تحميل هذه الصفحة. يمكنك المحاولة مرة أخرى."
          actions={
            <>
              <Button className="w-full sm:w-auto">إعادة المحاولة</Button>
              <Link href="/">
                <Button variant="secondary" className="w-full sm:w-auto">
                  العودة للرئيسية
                </Button>
              </Link>
            </>
          }
          hint="digest_xy12ab9f3"
        />
      </Section>

      <Section label="Network — لا يوجد اتصال">
        <ErrorScreen
          illustration={<OfflineIllustration />}
          title="لا يوجد اتصال بالإنترنت"
          description="تعذر الوصول إلى الخادم. تحقق من اتصالك بالإنترنت ثم أعد المحاولة."
          actions={
            <Button className="w-full sm:w-auto">إعادة المحاولة</Button>
          }
        />
      </Section>

      <Section label="403 — صلاحية مرفوضة">
        <ErrorScreen
          illustration={<ForbiddenIllustration />}
          title="ليس لديك صلاحية الوصول"
          description="هذه الصفحة محظورة على دورك الحالي. تواصل مع مالك المتجر لمنحك الصلاحيات اللازمة."
          actions={
            <Link href="/">
              <Button className="w-full sm:w-auto">العودة للرئيسية</Button>
            </Link>
          }
        />
      </Section>

      <Section label="Empty — لا توجد بيانات">
        <ErrorScreen
          illustration={<EmptyIllustration />}
          title="لا توجد بيانات بعد"
          description="ابدأ بإضافة أول صنف ليظهر هنا في قائمة المخزن."
          actions={
            <Button className="w-full sm:w-auto">إضافة صنف جديد</Button>
          }
        />
      </Section>
    </div>
  );
}
