import type { UtmContext } from "./track";

export type PublicLeadPayload = {
  name: string;
  phone: string;
  service?: string;
  message?: string;
  source: "landing" | "landing-v2";
  utm?: UtmContext;
  website?: string;
};

type PublicLeadResponse = {
  success?: boolean;
  lead_id?: string;
  received_at?: string;
  error?: string;
};

class PublicLeadSubmissionError extends Error {}

async function responseJson(response: Response): Promise<PublicLeadResponse | null> {
  try {
    return await response.json() as PublicLeadResponse;
  } catch {
    return null;
  }
}

function publicLeadError(status: number) {
  if (status === 429) return "أرسلت عدة محاولات خلال وقت قصير. انتظر قليلاً ثم حاول مرة أخرى.";
  if (status >= 500) return "تعذر حفظ طلبك الآن بسبب مشكلة مؤقتة في الخادم. حاول مرة أخرى بعد قليل.";
  if (status === 400) return "تحقق من الاسم ورقم الجوال ثم أعد إرسال الطلب.";
  if (status === 404) return "خدمة إرسال الطلب غير متاحة الآن. حاول مرة أخرى بعد قليل.";
  if (status === 401 || status === 403) return "تعذر السماح بإرسال الطلب الآن. حدّث الصفحة ثم حاول مرة أخرى.";
  return "تعذر إرسال طلبك الآن. حاول مرة أخرى أو استخدم وسيلة تواصل أخرى.";
}

export async function submitPublicLead(
  payload: PublicLeadPayload,
  fetcher: typeof fetch = fetch,
) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetcher("/api/leads/public", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await responseJson(response);
    if (!response.ok) throw new PublicLeadSubmissionError(publicLeadError(response.status));
    if (!body?.success) throw new PublicLeadSubmissionError("لم يؤكد الخادم حفظ الطلب. أعد المحاولة بعد قليل.");
    return body;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("استغرق إرسال الطلب وقتاً أطول من المتوقع. تحقق من الاتصال ثم حاول مرة أخرى.");
    }
    if (error instanceof PublicLeadSubmissionError) throw error;
    throw new Error("تعذر الاتصال بخدمة الطلبات. تحقق من اتصالك ثم حاول مرة أخرى.");
  } finally {
    globalThis.clearTimeout(timer);
  }
}
