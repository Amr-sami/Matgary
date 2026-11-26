// Plan catalog. The whole app reads from here so prices and labels stay in
// one place. EGP-only for now (Egyptian market launch); revisit when we
// support a second country.

export type PlanKey = "trial" | "professional" | "multi_branch";

export interface PlanDefinition {
  key: PlanKey;
  /** Arabic display name (used on /billing). */
  label: string;
  /** Short Arabic tagline shown under the price. */
  tagline: string;
  /** Monthly price in EGP. 0 means "not directly purchasable" (trial / placeholder). */
  monthlyEgp: number;
  /** Whether this plan can be subscribed to right now. */
  purchasable: boolean;
  /** Bullet-point feature list, Arabic. */
  features: string[];
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  trial: {
    key: "trial",
    label: "تجربة مجانية",
    tagline: "كل المميزات لمدة 14 يوم",
    monthlyEgp: 0,
    purchasable: false,
    features: [
      "كل ميزات الباقة الاحترافية",
      "بدون بطاقة ائتمان",
      "تتحول للباقة المختارة بعد انتهاء الفترة",
    ],
  },
  professional: {
    key: "professional",
    label: "احترافي",
    tagline: "متجر واحد — كل ما يحتاجه عملك",
    monthlyEgp: 299,
    purchasable: true,
    features: [
      "نقطة بيع، مخزون، فواتير، تقارير",
      "إدارة الموظفين والصلاحيات",
      "حضور وانصراف بالموقع الجغرافي",
      "إرسال الفواتير عبر WhatsApp",
      "نسخ احتياطي يومي تلقائي",
      "دعم فني على WhatsApp",
    ],
  },
  multi_branch: {
    key: "multi_branch",
    label: "متعدد الفروع",
    tagline: "قريباً — لإدارة أكثر من فرع",
    monthlyEgp: 0,
    purchasable: false,
    features: [
      "كل مميزات الباقة الاحترافية",
      "إدارة عدة فروع من نفس الحساب",
      "تقارير موحَّدة بين الفروع",
      "تحويل المخزون بين الفروع",
    ],
  },
};

/** TTL for the trial that ships with every fresh signup. */
export const TRIAL_DAYS = 30;

/** Days a tenant remains usable after a payment fails before we lock them out. */
export const PAYMENT_GRACE_DAYS = 7;

export function trialEndsFromNow(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d;
}
