// ─── KYC / Verification shared constants ─────────────────────────────────────
// Used by BOTH the RN client (form dropdown + field routing) and BOTH Express
// server copies (submit validation). Keep root shared/kyc.ts and
// shib-mine-backend/shared/kyc.ts byte-identical.
//
// `supported: true`  → country is on the Global Binance Supported list
//                      (form shows BOTH Binance Email + BEP20 fields).
// `supported: false` → BEP20-only route.
// `blocked: true`    → submission completely blocked (Iran).
//
// Withdrawal rule (server-enforced): method "binance" is allowed ONLY for
// kyc_country === "India". Every other country withdraws via BEP20 only.

export interface KycCountry {
  name: string;
  dial: string;
  supported: boolean;
  blocked?: boolean;
}

export const KYC_COUNTRIES: KycCountry[] = [
  { name: "Afghanistan", dial: "+93", supported: true },
  { name: "Albania", dial: "+355", supported: true },
  { name: "Algeria", dial: "+213", supported: true },
  { name: "Angola", dial: "+244", supported: true },
  { name: "Anguilla", dial: "+1264", supported: true },
  { name: "Antigua and Barbuda", dial: "+1268", supported: true },
  { name: "Argentina", dial: "+54", supported: true },
  { name: "Armenia", dial: "+374", supported: true },
  { name: "Australia", dial: "+61", supported: true },
  { name: "Austria", dial: "+43", supported: true },
  { name: "Azerbaijan", dial: "+994", supported: true },
  { name: "Bahamas (the)", dial: "+1242", supported: true },
  { name: "Bahrain", dial: "+973", supported: true },
  { name: "Bangladesh", dial: "+880", supported: false },
  { name: "Barbados", dial: "+1246", supported: true },
  { name: "Belarus", dial: "+375", supported: true },
  { name: "Belgium", dial: "+32", supported: true },
  { name: "Belize", dial: "+501", supported: true },
  { name: "Benin", dial: "+229", supported: true },
  { name: "Bermuda", dial: "+1441", supported: true },
  { name: "Bhutan", dial: "+975", supported: true },
  { name: "Bolivia (Plurinational State of)", dial: "+591", supported: true },
  { name: "Bosnia and Herzegovina", dial: "+387", supported: true },
  { name: "Botswana", dial: "+267", supported: true },
  { name: "Brazil", dial: "+55", supported: true },
  { name: "Brunei Darussalam", dial: "+673", supported: true },
  { name: "Bulgaria", dial: "+359", supported: true },
  { name: "Burkina Faso", dial: "+226", supported: true },
  { name: "Cabo Verde", dial: "+238", supported: true },
  { name: "Cambodia", dial: "+855", supported: true },
  { name: "Cameroon", dial: "+237", supported: true },
  { name: "Canada", dial: "+1", supported: true },
  { name: "Cayman Islands (the)", dial: "+1345", supported: true },
  { name: "Chad", dial: "+235", supported: true },
  { name: "Chile", dial: "+56", supported: true },
  { name: "China", dial: "+86", supported: false },
  { name: "Colombia", dial: "+57", supported: true },
  { name: "Congo (the Democratic Republic of the)", dial: "+243", supported: true },
  { name: "Congo (the)", dial: "+242", supported: true },
  { name: "Costa Rica", dial: "+506", supported: true },
  { name: "Côte d'Ivoire", dial: "+225", supported: true },
  { name: "Croatia", dial: "+385", supported: true },
  { name: "Cuba", dial: "+53", supported: false },
  { name: "Cyprus", dial: "+357", supported: true },
  { name: "Czechia", dial: "+420", supported: true },
  { name: "Denmark", dial: "+45", supported: true },
  { name: "Dominica", dial: "+1767", supported: true },
  { name: "Dominican Republic (the)", dial: "+1809", supported: true },
  { name: "Ecuador", dial: "+593", supported: true },
  { name: "Egypt", dial: "+20", supported: true },
  { name: "El Salvador", dial: "+503", supported: true },
  { name: "Estonia", dial: "+372", supported: true },
  { name: "Eswatini", dial: "+268", supported: true },
  { name: "Ethiopia", dial: "+251", supported: false },
  { name: "Fiji", dial: "+679", supported: true },
  { name: "Finland", dial: "+358", supported: true },
  { name: "France", dial: "+33", supported: true },
  { name: "Gabon", dial: "+241", supported: true },
  { name: "Gambia (the)", dial: "+220", supported: true },
  { name: "Georgia", dial: "+995", supported: true },
  { name: "Germany", dial: "+49", supported: true },
  { name: "Ghana", dial: "+233", supported: true },
  { name: "Greece", dial: "+30", supported: true },
  { name: "Grenada", dial: "+1473", supported: true },
  { name: "Guatemala", dial: "+502", supported: true },
  { name: "Guinea-Bissau", dial: "+245", supported: true },
  { name: "Guyana", dial: "+592", supported: true },
  { name: "Haiti", dial: "+509", supported: false },
  { name: "Honduras", dial: "+504", supported: true },
  { name: "Hong Kong", dial: "+852", supported: true },
  { name: "Hungary", dial: "+36", supported: true },
  { name: "Iceland", dial: "+354", supported: true },
  { name: "India", dial: "+91", supported: true },
  { name: "Indonesia", dial: "+62", supported: true },
  { name: "Iran", dial: "+98", supported: false, blocked: true },
  { name: "Iraq", dial: "+964", supported: true },
  { name: "Ireland", dial: "+353", supported: true },
  { name: "Israel", dial: "+972", supported: true },
  { name: "Italy", dial: "+39", supported: true },
  { name: "Jamaica", dial: "+1876", supported: true },
  { name: "Japan", dial: "+81", supported: false },
  { name: "Jordan", dial: "+962", supported: true },
  { name: "Kazakhstan", dial: "+7", supported: true },
  { name: "Kenya", dial: "+254", supported: true },
  { name: "Kosovo", dial: "+383", supported: true },
  { name: "Kuwait", dial: "+965", supported: true },
  { name: "Kyrgyzstan", dial: "+996", supported: true },
  { name: "Lao People's Democratic Republic (the)", dial: "+856", supported: true },
  { name: "Latvia", dial: "+371", supported: true },
  { name: "Lebanon", dial: "+961", supported: true },
  { name: "Liberia", dial: "+231", supported: true },
  { name: "Libya", dial: "+218", supported: true },
  { name: "Lithuania", dial: "+370", supported: true },
  { name: "Luxembourg", dial: "+352", supported: true },
  { name: "Macao", dial: "+853", supported: true },
  { name: "Madagascar", dial: "+261", supported: true },
  { name: "Malawi", dial: "+265", supported: true },
  { name: "Malaysia", dial: "+60", supported: false },
  { name: "Maldives", dial: "+960", supported: true },
  { name: "Mali", dial: "+223", supported: true },
  { name: "Malta", dial: "+356", supported: true },
  { name: "Mauritania", dial: "+222", supported: true },
  { name: "Mauritius", dial: "+230", supported: true },
  { name: "Mexico", dial: "+52", supported: true },
  { name: "Micronesia (Federated States of)", dial: "+691", supported: true },
  { name: "Moldova (the Republic of)", dial: "+373", supported: true },
  { name: "Mongolia", dial: "+976", supported: true },
  { name: "Montenegro", dial: "+382", supported: true },
  { name: "Montserrat", dial: "+1664", supported: true },
  { name: "Morocco", dial: "+212", supported: true },
  { name: "Mozambique", dial: "+258", supported: true },
  { name: "Myanmar", dial: "+95", supported: true },
  { name: "Namibia", dial: "+264", supported: true },
  { name: "Nauru", dial: "+674", supported: true },
  { name: "Nepal", dial: "+977", supported: true },
  { name: "Netherlands", dial: "+31", supported: false },
  { name: "New Zealand", dial: "+64", supported: true },
  { name: "Nicaragua", dial: "+505", supported: true },
  { name: "Niger (the)", dial: "+227", supported: true },
  { name: "Nigeria", dial: "+234", supported: true },
  { name: "Norway", dial: "+47", supported: true },
  { name: "Oman", dial: "+968", supported: true },
  { name: "Pakistan", dial: "+92", supported: true },
  { name: "Palau", dial: "+680", supported: true },
  { name: "Panama", dial: "+507", supported: true },
  { name: "Papua New Guinea", dial: "+675", supported: true },
  { name: "Paraguay", dial: "+595", supported: true },
  { name: "Peru", dial: "+51", supported: true },
  { name: "Philippines (the)", dial: "+63", supported: true },
  { name: "Poland", dial: "+48", supported: true },
  { name: "Portugal", dial: "+351", supported: true },
  { name: "Qatar", dial: "+974", supported: true },
  { name: "Republic of North Macedonia", dial: "+389", supported: true },
  { name: "Romania", dial: "+40", supported: true },
  { name: "Russian Federation (the)", dial: "+7", supported: true },
  { name: "Rwanda", dial: "+250", supported: true },
  { name: "Saint Kitts and Nevis", dial: "+1869", supported: true },
  { name: "Saint Lucia", dial: "+1758", supported: true },
  { name: "Saint Vincent and the Grenadines", dial: "+1784", supported: true },
  { name: "Sao Tome and Principe", dial: "+239", supported: true },
  { name: "Saudi Arabia", dial: "+966", supported: true },
  { name: "Senegal", dial: "+221", supported: true },
  { name: "Serbia", dial: "+381", supported: true },
  { name: "Seychelles", dial: "+248", supported: true },
  { name: "Sierra Leone", dial: "+232", supported: true },
  { name: "Singapore", dial: "+65", supported: true },
  { name: "Slovakia", dial: "+421", supported: true },
  { name: "Slovenia", dial: "+386", supported: true },
  { name: "Solomon Islands", dial: "+677", supported: true },
  { name: "Somalia", dial: "+252", supported: false },
  { name: "South Africa", dial: "+27", supported: true },
  { name: "South Korea", dial: "+82", supported: true },
  { name: "Spain", dial: "+34", supported: true },
  { name: "Sri Lanka", dial: "+94", supported: true },
  { name: "Sudan", dial: "+249", supported: false },
  { name: "Suriname", dial: "+597", supported: true },
  { name: "Sweden", dial: "+46", supported: true },
  { name: "Switzerland", dial: "+41", supported: true },
  { name: "Syria", dial: "+963", supported: false },
  { name: "Taiwan", dial: "+886", supported: true },
  { name: "Tajikistan", dial: "+992", supported: true },
  { name: "Tanzania, United Republic of", dial: "+255", supported: true },
  { name: "Thailand", dial: "+66", supported: true },
  { name: "Tonga", dial: "+676", supported: true },
  { name: "Trinidad and Tobago", dial: "+1868", supported: true },
  { name: "Tunisia", dial: "+216", supported: true },
  { name: "Turkey", dial: "+90", supported: true },
  { name: "Turkmenistan", dial: "+993", supported: true },
  { name: "Turks and Caicos Islands (the)", dial: "+1649", supported: true },
  { name: "Uganda", dial: "+256", supported: true },
  { name: "Ukraine", dial: "+380", supported: true },
  { name: "United Arab Emirates (the)", dial: "+971", supported: true },
  { name: "United Kingdom of Great Britain and Northern Ireland (the)", dial: "+44", supported: true },
  { name: "United States of America", dial: "+1", supported: false },
  { name: "Uruguay", dial: "+598", supported: true },
  { name: "Uzbekistan", dial: "+998", supported: true },
  { name: "Vanuatu", dial: "+678", supported: true },
  { name: "Venezuela (Bolivarian Republic of)", dial: "+58", supported: true },
  { name: "Viet Nam", dial: "+84", supported: true },
  { name: "Virgin Islands (British)", dial: "+1284", supported: true },
  { name: "Yemen", dial: "+967", supported: true },
  { name: "Zambia", dial: "+260", supported: true },
  { name: "Zimbabwe", dial: "+263", supported: true },
];

export function findKycCountry(name: string): KycCountry | undefined {
  return KYC_COUNTRIES.find((c) => c.name === name);
}

export function isKycCountryBlocked(name: string): boolean {
  return !!findKycCountry(name)?.blocked;
}

export function isBinanceSupported(name: string): boolean {
  const c = findKycCountry(name);
  return !!c && c.supported && !c.blocked;
}

// The only country whose users may withdraw via Binance Email.
export const BINANCE_WITHDRAW_COUNTRY = "India";

// KYC status values stored in users.kyc_status ("" / "none" = never submitted)
export type KycStatus = "none" | "under_review" | "verified" | "rejected";

export function normalizeKycStatus(v: unknown): KycStatus {
  if (v === "under_review" || v === "verified" || v === "rejected") return v;
  // Also accept the PocketBase SELECT labels used by verification_requests.status
  // ('Under Review' | 'Verified' | 'Rejected') plus legacy synonyms.
  const k = String(v ?? "").trim().toLowerCase().replace(/[\s_]+/g, "_");
  if (k === "under_review" || k === "pending") return "under_review";
  if (k === "verified" || k === "approved") return "verified";
  if (k === "rejected" || k === "unverified") return "rejected";
  return "none";
}

// Admin rejection reasons (spec: admin must pick one; it is shown to the user)
export const KYC_REJECT_REASONS = [
  "Binance email not linked",
  "Data duplicate",
  "Invalid BEP20 wallet address",
  "Incorrect name or phone number",
  "Country mismatch",
  "Other / contact support",
] as const;

export function validateBep20Address(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
}

export function validateKycEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateKycPhone(phone: string): boolean {
  return /^[0-9]{5,15}$/.test(phone.trim());
}
