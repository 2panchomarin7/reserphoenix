export type Sport = "tennis" | "football";
export type BookingStatus = "open" | "full" | "checked_in" | "no_show" | "cancelled";

export type Profile = {
  id: string;
  home_id: string;
  full_name: string;
  role: "neighbor" | "admin";
  homes?: { label: string } | null;
};

export type Booking = {
  id: string;
  sport: Sport;
  status: BookingStatus;
  slot_start: string;
  local_date: string;
  creator_user_id: string;
  creator_home_id: string;
  profiles?: { full_name: string; homes?: { label: string } | null } | null;
  participant_count?: number;
  waitlist_count?: number;
};

export const SPORT_LABELS: Record<Sport, string> = {
  tennis: "Tenis",
  football: "Fútbol"
};

export const SPORT_CAPACITY: Record<Sport, number> = {
  tennis: 4,
  football: 15
};
