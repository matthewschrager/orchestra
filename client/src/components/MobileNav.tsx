interface MobileNavProps {
  activeTab: "inbox" | "sessions" | "new";
  onTabChange: (tab: "inbox" | "sessions" | "new") => void;
  attentionCount: number;
}

export function MobileNav({ activeTab, onTabChange, attentionCount }: MobileNavProps) {
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 bg-surface-1 border-t border-edge-1 z-30"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      role="tablist"
    >
      <div className="flex justify-around items-center h-14">
        <TabButton
          label="Inbox"
          icon={<InboxIcon />}
          active={activeTab === "inbox"}
          badge={attentionCount}
          onClick={() => onTabChange("inbox")}
        />
        <TabButton
          label="Sessions"
          icon={<SessionsIcon />}
          active={activeTab === "sessions"}
          onClick={() => onTabChange("sessions")}
        />
        <TabButton
          label="New"
          icon={<PlusIcon />}
          active={activeTab === "new"}
          onClick={() => onTabChange("new")}
        />
      </div>
    </nav>
  );
}

function TabButton({ label, icon, active, badge, onClick }: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-col items-center justify-center min-w-[64px] min-h-[44px] px-3 py-1 relative ${
        active ? "text-accent" : "text-content-3"
      }`}
    >
      <div className="relative">
        {icon}
        {badge !== undefined && badge > 0 && (
          <span
            className="absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold px-1"
            aria-label={`${badge} items need attention`}
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </div>
      <span className="text-[10px] mt-0.5">{label}</span>
    </button>
  );
}

function InboxIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10h3.5l1.5 3h5l1.5-3H18" />
      <path d="M3 10V5a2 2 0 012-2h10a2 2 0 012 2v5m0 0v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5" />
    </svg>
  );
}

function SessionsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="M3 8h14" />
      <path d="M8 3v14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}
