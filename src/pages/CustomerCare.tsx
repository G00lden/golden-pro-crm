import { Send, RefreshCcw, ClipboardList } from "lucide-react";
import { useState } from "react";
import * as api from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBlock,
  Loading,
  PageHeader,
  careReasonLabel,
  careTone,
  daysLabel,
  fmtDate,
  phoneLabel,
  useData,
} from "../shared";

export default function CustomerCarePage({
  notify,
  refreshStats,
}: {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
}) {
  const queue = useData(api.getCustomerCareQueue);
  const [sendingId, setSendingId] = useState("");

  const copyPhone = async (phone: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(phone);
      notify("تم نسخ رقم العميل");
    } catch {
      notify(`تعذّر النسخ تلقائيًا. الرقم: ${phone}`, false);
    }
  };

  const sendReminder = async (item: api.CustomerCareItem) => {
    if (!item.installation_id) {
      notify("هذا العميل يحتاج تواصل يدوي أولا قبل إرسال تذكير صيانة.", false);
      return;
    }

    setSendingId(item.id);
    try {
      await api.remindInstallation(item.installation_id, "first");
      notify("تم إرسال التذكير وإخراج العميل من قائمة الإهمال");
      await Promise.all([queue.refresh(), refreshStats()]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر إرسال التذكير", false);
    } finally {
      setSendingId("");
    }
  };

  return (
    <>
      <PageHeader
        title="رعاية العملاء"
        subtitle="قائمة يومية لأي عميل يحتاج متابعة حتى لا يضيع بين الطلبات والحجوزات"
        actions={<Button tone="muted" onClick={queue.refresh}><RefreshCcw size={16} /> تحديث</Button>}
      />

      {queue.loading ? <Loading /> : queue.error ? <ErrorBlock message={queue.error} retry={queue.refresh} /> : (
        <div className="list">
          {(queue.data || []).map((item) => (
            <article className="row-card" key={item.id}>
              <div className="row-main">
                <strong>{item.customer_name}</strong>
                <span>{phoneLabel(item.customer_phone)} · {item.city || "بدون مدينة"} · {item.source === "salla" ? "سلة" : "يدوي"}</span>
                <div className="chips">
                  <Badge tone={careTone(item.priority)}>{careReasonLabel(item.reason)}</Badge>
                  {item.product_name && <Badge>{item.product_name}</Badge>}
                  {item.next_maintenance && <Badge>{fmtDate(item.next_maintenance)} · {daysLabel(item.days_until)}</Badge>}
                </div>
                <em>{item.next_action}</em>
              </div>
              <div className="row-actions">
                {item.installation_id ? (
                  <Button tone="success" loading={sendingId === item.id} onClick={() => sendReminder(item)}>
                    <Send size={16} /> إرسال تذكير
                  </Button>
                ) : (
                  <Button tone="muted" onClick={() => copyPhone(item.customer_phone)}>
                    <ClipboardList size={16} /> نسخ الرقم
                  </Button>
                )}
              </div>
            </article>
          ))}
          {!queue.data?.length && <Empty title="كل العملاء لديهم مسار متابعة واضح" />}
        </div>
      )}
    </>
  );
}
