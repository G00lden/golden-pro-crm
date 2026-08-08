import { FileText, Receipt } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { InvoicesPage } from "./Invoices";
import { QuotesPage } from "./Quotes";

export type BillingTab = "invoices" | "quotes";

type BillingLocation = {
  tab: BillingTab;
  invoiceId: string;
  quoteId: string;
};

type BillingWorkspaceProps = {
  notify: (message: string, ok?: boolean) => void;
  refreshStats: () => Promise<void>;
  initialTab?: BillingTab;
};

const BILLING_LOCATION_EVENT = "golden-pro:billing-location";
const BILLING_TABS: BillingTab[] = ["invoices", "quotes"];

function readBillingLocation(initialTab: BillingTab): BillingLocation {
  const url = new URL(window.location.href);
  const requestedTab = url.searchParams.get("billingTab");
  const legacyQuoteRoute = url.searchParams.get("section") === "quotes";
  return {
    tab: legacyQuoteRoute || requestedTab === "quotes" ? "quotes" : initialTab,
    invoiceId: url.searchParams.get("invoiceId") || "",
    quoteId: url.searchParams.get("quoteId") || "",
  };
}

export function notifyBillingLocationChanged() {
  window.dispatchEvent(new Event(BILLING_LOCATION_EVENT));
}

export function BillingWorkspace({
  notify,
  refreshStats,
  initialTab = "invoices",
}: BillingWorkspaceProps) {
  const [location, setLocation] = useState(() => readBillingLocation(initialTab));

  const restoreLocation = useCallback(() => {
    setLocation(readBillingLocation(initialTab));
  }, [initialTab]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("section") === "quotes") {
      url.searchParams.set("section", "invoices");
      url.searchParams.set("billingTab", "quotes");
      window.history.replaceState({}, "", url);
    }
    restoreLocation();
    window.addEventListener("popstate", restoreLocation);
    window.addEventListener(BILLING_LOCATION_EVENT, restoreLocation);
    return () => {
      window.removeEventListener("popstate", restoreLocation);
      window.removeEventListener(BILLING_LOCATION_EVENT, restoreLocation);
    };
  }, [restoreLocation]);

  const selectTab = useCallback((
    tab: BillingTab,
    focus: { invoiceId?: string; quoteId?: string } = {},
  ) => {
    const next: BillingLocation = {
      tab,
      invoiceId: tab === "invoices" ? focus.invoiceId || "" : "",
      quoteId: tab === "quotes" ? focus.quoteId || "" : "",
    };
    setLocation(next);
    const url = new URL(window.location.href);
    url.searchParams.set("section", "invoices");
    if (tab === "quotes") url.searchParams.set("billingTab", "quotes");
    else url.searchParams.delete("billingTab");
    if (next.invoiceId) url.searchParams.set("invoiceId", next.invoiceId);
    else url.searchParams.delete("invoiceId");
    if (next.quoteId) url.searchParams.set("quoteId", next.quoteId);
    else url.searchParams.delete("quoteId");
    if (url.href !== window.location.href) window.history.pushState({}, "", url);
  }, []);

  const tabs = useMemo(() => ([
    { id: "invoices" as const, label: "الفواتير", icon: Receipt },
    { id: "quotes" as const, label: "عروض الأسعار", icon: FileText },
  ]), []);

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: BillingTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = BILLING_TABS.indexOf(tab);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const rightStep = rtl ? -1 : 1;
    const next = event.key === "Home"
      ? BILLING_TABS[0]
      : event.key === "End"
        ? BILLING_TABS[BILLING_TABS.length - 1]
        : BILLING_TABS[
            (currentIndex + (event.key === "ArrowRight" ? rightStep : -rightStep) + BILLING_TABS.length)
            % BILLING_TABS.length
          ];
    selectTab(next);
    window.requestAnimationFrame(() => document.getElementById(`billing-tab-${next}`)?.focus());
  };

  return (
    <div className="billing-workspace">
      <nav className="tabs billing-workspace-tabs" role="tablist" aria-label="الفواتير وعروض الأسعار">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            id={`billing-tab-${id}`}
            key={id}
            type="button"
            role="tab"
            aria-selected={location.tab === id}
            aria-controls={`billing-panel-${id}`}
            tabIndex={location.tab === id ? 0 : -1}
            className={location.tab === id ? "active" : ""}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => handleTabKey(event, id)}
          >
            <Icon size={17} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>

      <section
        id={`billing-panel-${location.tab}`}
        className="billing-workspace-panel"
        role="tabpanel"
        aria-labelledby={`billing-tab-${location.tab}`}
      >
        {location.tab === "quotes" ? (
          <QuotesPage
            notify={notify}
            refreshStats={refreshStats}
            focusQuoteId={location.quoteId}
            onOpenInvoice={(invoiceId) => selectTab("invoices", { invoiceId })}
          />
        ) : (
          <InvoicesPage
            notify={notify}
            refreshStats={refreshStats}
            focusInvoiceId={location.invoiceId}
            onOpenQuote={(quoteId) => selectTab("quotes", { quoteId })}
          />
        )}
      </section>
    </div>
  );
}
