import { BanknoteArrowDown, Gift, RefreshCcw, Save, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import * as api from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorBlock,
  Field,
  Loading,
  PageHeader,
  SelectInput,
  TextInput,
  type ModalState,
  useData,
} from "../shared";

const money = new Intl.NumberFormat("ar-SA", { style: "currency", currency: "SAR" });
const dateTime = new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", timeStyle: "short" });
const jobTypes: api.FieldTechRewardRule["jobType"][] = ["تركيب", "صيانة", "توصيل"];
const statusLabel: Record<api.FieldTechWithdrawal["status"], string> = {
  pending: "قيد المراجعة",
  deferred: "مؤجل",
  rejected: "مرفوض",
  approved: "معتمد للصرف",
  paid: "تم الصرف",
};

function sar(halalas: number) {
  return money.format(Number(halalas || 0) / 100);
}

function statusTone(status: api.FieldTechWithdrawal["status"]): "success" | "warn" | "danger" | "muted" {
  if (status === "paid") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending" || status === "deferred") return "warn";
  return "muted";
}

export default function TechnicianWalletPage({
  notify,
  setModal,
}: {
  notify: (message: string, ok?: boolean) => void;
  setModal: (modal: ModalState) => void;
}) {
  const financials = useData(api.getFieldTechFinancials);
  const [selectedId, setSelectedId] = useState("");
  const [rewardValues, setRewardValues] = useState<Record<api.FieldTechRewardRule["jobType"], number>>({ تركيب: 0, صيانة: 0, توصيل: 0 });
  const [busy, setBusy] = useState("");

  const selected = financials.data?.technicians.find((item) => item.id === selectedId) || financials.data?.technicians[0];

  useEffect(() => {
    if (!selectedId && financials.data?.technicians[0]) setSelectedId(financials.data.technicians[0].id);
  }, [financials.data, selectedId]);

  useEffect(() => {
    if (!selected) return;
    const next = { تركيب: 0, صيانة: 0, توصيل: 0 };
    for (const rule of selected.rewardRules) next[rule.jobType] = rule.amountHalalas / 100;
    setRewardValues(next);
  }, [selected?.id, financials.data]);

  const totals = useMemo(() => (financials.data?.technicians || []).reduce((summary, item) => ({
    ledger: summary.ledger + item.wallet.ledgerHalalas,
    available: summary.available + item.wallet.availableHalalas,
    held: summary.held + item.wallet.heldHalalas,
    paid: summary.paid + item.wallet.paidHalalas,
  }), { ledger: 0, available: 0, held: 0, paid: 0 }), [financials.data]);

  const saveRewards = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy("rules");
    try {
      await api.updateFieldTechRewardRules(selected.id, Object.fromEntries(
        jobTypes.map((type) => [type, Math.round(Number(rewardValues[type] || 0) * 100)]),
      ) as Record<api.FieldTechRewardRule["jobType"], number>);
      notify(`تم حفظ مكافآت ${selected.name}`);
      await financials.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر حفظ المكافآت", false);
    } finally {
      setBusy("");
    }
  };

  const review = async (request: api.FieldTechWithdrawal, action: "approve" | "defer" | "reject") => {
    let reason = "";
    if (action !== "approve") {
      reason = window.prompt(action === "defer" ? "اكتب سبب تأجيل طلب السحب:" : "اكتب سبب رفض طلب السحب:")?.trim() || "";
      if (!reason) return;
    }
    const verb = action === "approve" ? "اعتماد" : action === "defer" ? "تأجيل" : "رفض";
    if (!window.confirm(`تأكيد ${verb} طلب سحب ${sar(request.amountHalalas)} للفني ${request.technicianName || "المحدد"}؟`)) return;
    setBusy(`review:${request.id}`);
    try {
      await api.reviewFieldTechWithdrawal(request.id, action, reason);
      notify(`تم ${verb} طلب السحب`);
      await financials.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "تعذر تحديث طلب السحب", false);
    } finally {
      setBusy("");
    }
  };

  const openPayment = (request: api.FieldTechWithdrawal) => {
    setModal({
      title: `تسجيل صرف ${request.technicianName || "الفني"}`,
      content: <PayoutForm request={request} onCancel={() => setModal(null)} onPaid={async () => {
        setModal(null);
        notify("تم توثيق التحويل وخصم المبلغ من المحفظة");
        await financials.refresh();
      }} />,
    });
  };

  return (
    <>
      <PageHeader
        title="محفظة الفنيين"
        subtitle="المكافآت، الرصيد المستحق، طلبات السحب، وتوثيق الصرف من مكان واحد."
        actions={<Button tone="muted" loading={financials.loading} onClick={financials.refresh}><RefreshCcw size={16} aria-hidden="true" /> تحديث</Button>}
      />

      {financials.loading && !financials.data ? <Loading /> : financials.error ? <ErrorBlock message={financials.error} retry={financials.refresh} /> : !financials.data?.technicians.length ? (
        <Empty title="لا توجد حسابات فنيين مرتبطة بالتطبيق بعد" />
      ) : <>
        <section className="cards-grid" aria-label="ملخص محفظة الفنيين">
          <article className="mini-card"><WalletCards size={20} aria-hidden="true" /><strong>{sar(totals.available)}</strong><span>متاح للسحب</span></article>
          <article className="mini-card"><BanknoteArrowDown size={20} aria-hidden="true" /><strong>{sar(totals.held)}</strong><span>معلّق بالمراجعة</span></article>
          <article className="mini-card"><Gift size={20} aria-hidden="true" /><strong>{sar(totals.ledger)}</strong><span>صافي المكافآت</span></article>
          <article className="mini-card"><strong>{sar(totals.paid)}</strong><span>إجمالي المصروف</span></article>
        </section>

        <section className="card" aria-labelledby="reward-rules-title" style={{ marginTop: 16 }}>
          <div className="page-head">
            <div><h2 id="reward-rules-title">مكافآت إكمال المهام</h2><p>تُضاف مرة واحدة بعد إغلاق المهمة في تطبيق الفني، وتُعكس تلقائيًا عند إعادة فتحها قبل الصرف.</p></div>
            <Field label="الفني"><SelectInput name="wallet_technician" autoComplete="off" value={selected?.id || ""} onChange={(event) => setSelectedId(event.target.value)}>{financials.data.technicians.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectInput></Field>
          </div>
          <form className="form" onSubmit={saveRewards}>
            <div className="form-grid">
              {jobTypes.map((type) => <Field key={type} label={`مكافأة ${type} (ر.س)`}><TextInput name={`reward_${type}`} type="number" inputMode="decimal" autoComplete="off" min={0} max={1_000_000} step="0.01" value={rewardValues[type]} onChange={(event) => setRewardValues((current) => ({ ...current, [type]: Number(event.target.value) }))} /></Field>)}
            </div>
            <div className="form-actions"><Button type="submit" loading={busy === "rules"}><Save size={16} aria-hidden="true" /> حفظ المكافآت</Button></div>
          </form>
        </section>

        <section className="card" aria-labelledby="withdrawals-title" style={{ marginTop: 16 }}>
          <div className="page-head"><div><h2 id="withdrawals-title">طلبات السحب</h2><p>{financials.data.requests.length} طلب مسجل</p></div></div>
          {!financials.data.requests.length ? <Empty title="لا توجد طلبات سحب بعد" /> : <div className="cards-grid">
            {financials.data.requests.map((request) => <article className="mini-card" key={request.id}>
              <div><strong>{request.technicianName || "فني"}</strong><span>{dateTime.format(new Date(request.createdAt))}</span></div>
              <p>{sar(request.amountHalalas)}{request.technicianNote ? ` · ${request.technicianNote}` : ""}</p>
              <div className="chips"><Badge tone={statusTone(request.status)}>{statusLabel[request.status]}</Badge>{request.transferReference && <Badge>{request.transferReference}</Badge>}</div>
              {request.managerReason && <p>ملاحظة الإدارة: {request.managerReason}</p>}
              <div className="row-actions">
                {["pending", "deferred"].includes(request.status) && <>
                  <Button tone="success" loading={busy === `review:${request.id}`} onClick={() => review(request, "approve")}>اعتماد</Button>
                  <Button tone="muted" disabled={Boolean(busy)} onClick={() => review(request, "defer")}>تأجيل</Button>
                  <Button tone="danger" disabled={Boolean(busy)} onClick={() => review(request, "reject")}>رفض</Button>
                </>}
                {request.status === "approved" && <Button onClick={() => openPayment(request)}>تسجيل الصرف</Button>}
              </div>
            </article>)}
          </div>}
        </section>

        {selected && <section className="card" aria-labelledby="wallet-ledger-title" style={{ marginTop: 16 }}>
          <div className="page-head"><div><h2 id="wallet-ledger-title">كشف حساب {selected.name}</h2><p>سجل غير قابل للحذف للمكافآت والعكس وعمليات الصرف.</p></div></div>
          {!selected.wallet.entries?.length ? <Empty title="لا توجد حركات مالية لهذا الفني" /> : <div className="cards-grid">{selected.wallet.entries.map((entry) => <article className="mini-card" key={entry.id}><div><strong>{entry.entryType === "commission" ? "مكافأة مكتسبة" : entry.entryType === "reversal" ? "عكس مكافأة" : "عملية صرف"}</strong><span>{dateTime.format(new Date(entry.createdAt))}</span></div><p>{entry.description}</p><strong dir="ltr">{entry.amountHalalas > 0 ? "+" : ""}{sar(entry.amountHalalas)}</strong></article>)}</div>}
        </section>}
      </>}
    </>
  );
}

function PayoutForm({ request, onCancel, onPaid }: { request: api.FieldTechWithdrawal; onCancel: () => void; onPaid: () => Promise<void> }) {
  const [reference, setReference] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!proof) return setError("أرفق إثبات التحويل بصيغة PNG أو JPG أو PDF.");
    if (proof.size > 1_000_000) return setError("حجم إثبات التحويل يجب ألا يتجاوز 1 MB.");
    if (!window.confirm(`تأكيد صرف ${sar(request.amountHalalas)}؟ سينشأ قيد مالي دائم.`)) return;
    setSaving(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("تعذر قراءة ملف الإثبات"));
        reader.readAsDataURL(proof);
      });
      await api.payFieldTechWithdrawal(request.id, {
        transferReference: reference.trim(),
        proof: { fileName: proof.name, mimeType: proof.type, dataBase64: dataUrl.split(",")[1] || "" },
      });
      await onPaid();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "تعذر تسجيل الصرف");
    } finally {
      setSaving(false);
    }
  };

  return <form className="form" onSubmit={submit}>
    <p>المبلغ: <strong>{sar(request.amountHalalas)}</strong></p>
    <Field label="مرجع التحويل"><TextInput required name="transfer_reference" autoComplete="off" minLength={3} maxLength={120} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="مثال: TRX-2026-001…" /></Field>
    <Field label="إثبات التحويل"><TextInput required name="transfer_proof" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(event) => setProof(event.target.files?.[0] || null)} /></Field>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-actions"><Button type="submit" loading={saving}>تأكيد الصرف</Button><Button tone="muted" onClick={onCancel}>إلغاء</Button></div>
  </form>;
}
