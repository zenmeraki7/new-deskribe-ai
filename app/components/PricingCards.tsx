import { useNavigate } from "@remix-run/react";

interface Plan {
  id: string;
  name: string;
  monthlyPrice: number;
  strikePrice: number;
  yearlyPrice: number;
  yearlyStrikePrice: number;
  description: string;
  features: { text: string; included: boolean }[];
  highlighted?: boolean;
  badge?: string;
}

const plans: Plan[] = [
  {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    strikePrice: 0,
    yearlyPrice: 0,
    yearlyStrikePrice: 0,
    description: "Get started with AI-powered descriptions",
    features: [
      { text: "10 AI descriptions / month", included: true },
      { text: "1 store connected", included: true },
      { text: "Basic templates", included: true },
      { text: "Email support", included: false },
      { text: "SEO optimization", included: false },
      { text: "Bulk generation", included: false },
      { text: "Custom tone & style", included: false },
    ],
  },
  {
    id: "basic",
    name: "Basic Plan",
    monthlyPrice: 9.99,
    strikePrice: 14.99,
    yearlyPrice: 83.92,
    yearlyStrikePrice: 119.88,
    description: "Perfect for growing stores",
    features: [
      { text: "200 AI descriptions / month", included: true },
      { text: "2 stores connected", included: true },
      { text: "All templates", included: true },
      { text: "Email support", included: true },
      { text: "SEO optimization", included: true },
      { text: "Bulk generation", included: false },
      { text: "Custom tone & style", included: false },
    ],
  },
  {
    id: "advanced",
    name: "Advanced Plan",
    monthlyPrice: 17.99,
    strikePrice: 24.99,
    yearlyPrice: 151.12,
    yearlyStrikePrice: 209.88,
    description: "For scaling product catalogs",
    highlighted: true,
    badge: "Most Popular",
    features: [
      { text: "1,000 AI descriptions / month", included: true },
      { text: "5 stores connected", included: true },
      { text: "All templates + custom", included: true },
      { text: "Priority email support", included: true },
      { text: "Advanced SEO optimization", included: true },
      { text: "Bulk generation (50/batch)", included: true },
      { text: "Custom tone & style", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro Plan",
    monthlyPrice: 24.99,
    strikePrice: 34.99,
    yearlyPrice: 209.92,
    yearlyStrikePrice: 299.88,
    description: "Unlimited power for large catalogs",
    features: [
      { text: "Unlimited AI descriptions", included: true },
      { text: "Unlimited stores", included: true },
      { text: "All templates + custom", included: true },
      { text: "24/7 priority support", included: true },
      { text: "Advanced SEO + keywords", included: true },
      { text: "Unlimited bulk generation", included: true },
      { text: "Custom tone & style", included: true },
    ],
  },
];

interface PricingCardsProps {
  billing: "monthly" | "yearly";
  currentPlanId?: string;
  onSelectPlan?: (planId: string) => void;
}

export function PricingCards({
  billing,
  currentPlanId,
  onSelectPlan,
}: PricingCardsProps) {
  return (
    <div style={styles.grid}>
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          billing={billing}
          isActive={currentPlanId === plan.id}
          onSelect={onSelectPlan}
        />
      ))}
    </div>
  );
}

function PlanCard({
  plan,
  billing,
  isActive,
  onSelect,
}: {
  plan: Plan;
  billing: "monthly" | "yearly";
  isActive?: boolean;
  onSelect?: (planId: string) => void;
}) {
  const isFree = plan.monthlyPrice === 0;
  const price = billing === "monthly" ? plan.monthlyPrice : plan.yearlyPrice / 12;
  const strike = billing === "monthly" ? plan.strikePrice : plan.yearlyStrikePrice / 12;
  const yearlyTotal = plan.yearlyPrice;
  const yearlyStrike = plan.yearlyStrikePrice;

  return (
    <div
      style={{
        ...styles.card,
        ...(plan.highlighted ? styles.cardHighlighted : {}),
        ...(isActive ? styles.cardActive : {}),
      }}
    >
      {plan.badge && (
        <div style={styles.badge}>{plan.badge}</div>
      )}

      {isActive && (
        <div style={styles.activeBadge}>Current Plan</div>
      )}

      <div style={styles.planName}>{plan.name}</div>
      <div style={styles.description}>{plan.description}</div>

      <div style={styles.priceBlock}>
        {isFree ? (
          <span style={styles.priceMain}>Free</span>
        ) : (
          <div style={styles.priceRow}>
            <span style={styles.strikePrice}>${strike.toFixed(2)}</span>
            <span style={styles.priceMain}>${price.toFixed(2)}</span>
            <span style={styles.pricePeriod}>/ mo</span>
          </div>
        )}

        {billing === "yearly" && !isFree && (
          <div style={styles.yearlyRow}>
            <span style={styles.yearlyStrike}>${yearlyStrike.toFixed(2)}/yr</span>
            <span style={styles.yearlyPrice}>&nbsp;${yearlyTotal.toFixed(2)}/yr</span>
            <span style={styles.savingBadge}>
              Save ${(yearlyStrike - yearlyTotal).toFixed(0)}
            </span>
          </div>
        )}

        {billing === "monthly" && !isFree && (
          <div style={styles.yearlyHint}>
            ${(yearlyTotal / 12).toFixed(2)}/mo billed yearly
          </div>
        )}
      </div>

      <div style={styles.divider} />

      <ul style={styles.featureList}>
        {plan.features.map((f, i) => (
          <li key={i} style={styles.featureItem}>
            <span style={{ ...styles.featureIcon, ...(f.included ? styles.iconYes : styles.iconNo) }}>
              {f.included ? (
                <svg width="9" height="9" viewBox="0 0 10 8" fill="none">
                  <polyline points="1,4 4,7 9,1" stroke="#3B6D11" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="9" height="9" viewBox="0 0 8 8" fill="none">
                  <line x1="2" y1="2" x2="6" y2="6" stroke="#9CA3AF" strokeWidth="1.6" strokeLinecap="round" />
                  <line x1="6" y1="2" x2="2" y2="6" stroke="#9CA3AF" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              )}
            </span>
            <span style={{ ...styles.featureText, ...(!f.included ? styles.featureTextMuted : {}) }}>
              {f.text}
            </span>
          </li>
        ))}
      </ul>

      <button
        style={{
          ...styles.selectBtn,
          ...(plan.highlighted ? styles.selectBtnPrimary : {}),
          ...(isActive ? styles.selectBtnActive : {}),
        }}
        onClick={() => !isActive && onSelect?.(plan.id)}
        disabled={isActive}
      >
        {isActive ? "Current Plan" : isFree ? "Get Started" : "Select Plan"}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "16px",
    width: "100%",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #E5E7EB",
    borderRadius: "12px",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    transition: "border-color 0.15s, box-shadow 0.15s",
  },
  cardHighlighted: {
    border: "2px solid #3B82F6",
    boxShadow: "0 4px 16px rgba(59,130,246,0.10)",
  },
  cardActive: {
    border: "2px solid #10B981",
    boxShadow: "0 4px 16px rgba(16,185,129,0.08)",
  },
  badge: {
    background: "#EFF6FF",
    color: "#1D4ED8",
    fontSize: "11px",
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: "20px",
    display: "inline-block",
    marginBottom: "12px",
    letterSpacing: "0.02em",
    alignSelf: "flex-start",
  },
  activeBadge: {
    background: "#ECFDF5",
    color: "#065F46",
    fontSize: "11px",
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: "20px",
    display: "inline-block",
    marginBottom: "12px",
    alignSelf: "flex-start",
  },
  planName: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#6B7280",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "4px",
  },
  description: {
    fontSize: "13px",
    color: "#9CA3AF",
    marginBottom: "16px",
    lineHeight: 1.5,
  },
  priceBlock: {
    marginBottom: "4px",
  },
  priceRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    flexWrap: "wrap",
  },
  priceMain: {
    fontSize: "30px",
    fontWeight: 700,
    color: "#111827",
    letterSpacing: "-0.02em",
  },
  strikePrice: {
    fontSize: "16px",
    color: "#D1D5DB",
    textDecoration: "line-through",
  },
  pricePeriod: {
    fontSize: "13px",
    color: "#9CA3AF",
  },
  yearlyRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    flexWrap: "wrap",
  },
  yearlyStrike: {
    fontSize: "12px",
    color: "#D1D5DB",
    textDecoration: "line-through",
  },
  yearlyPrice: {
    fontSize: "12px",
    color: "#6B7280",
  },
  savingBadge: {
    background: "#F0FDF4",
    color: "#15803D",
    fontSize: "11px",
    fontWeight: 600,
    padding: "2px 7px",
    borderRadius: "20px",
  },
  yearlyHint: {
    fontSize: "12px",
    color: "#9CA3AF",
    marginTop: "5px",
  },
  divider: {
    borderTop: "1px solid #F3F4F6",
    margin: "16px 0",
  },
  featureList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    flex: 1,
  },
  featureItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: "9px",
  },
  featureIcon: {
    width: "16px",
    height: "16px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    marginTop: "1px",
  },
  iconYes: {
    background: "#DCFCE7",
  },
  iconNo: {
    background: "#F3F4F6",
  },
  featureText: {
    fontSize: "13px",
    color: "#374151",
    lineHeight: 1.5,
  },
  featureTextMuted: {
    color: "#D1D5DB",
  },
  selectBtn: {
    marginTop: "20px",
    padding: "9px 16px",
    borderRadius: "8px",
    border: "1px solid #E5E7EB",
    background: "transparent",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    color: "#374151",
    width: "100%",
    transition: "all 0.15s",
  },
  selectBtnPrimary: {
    background: "#1C1C1C",
    color: "#ffffff",
    border: "1px solid #1C1C1C",
  },
  selectBtnActive: {
    background: "#F9FAFB",
    color: "#9CA3AF",
    cursor: "default",
    border: "1px solid #E5E7EB",
  },
};