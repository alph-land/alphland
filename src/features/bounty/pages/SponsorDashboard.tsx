import type { Bounty } from "../types/bounty.types";
import type { Sponsor } from "../types/sponsor.types";
import type { Submission } from "../types/submission.types";
import { SubmissionReviewModal } from "../components/SubmissionReviewModal";
import { BountySubmission } from "@/lib/api-client";
import { formatBountyReward, submissionTitle } from "../utils";
import {
  getBountyDisplayStatus,
  type BountyDisplayStatus,
} from "../utils/bountyStatus";
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Edit,
  Mail,
  Plus,
  RefreshCw,
  Send,
  TrendingUp,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState, useEffect, useCallback } from "react";
import { toast } from "react-toastify";
import { useSession } from "@/lib/auth-client";
import Layout from "@/components/Layout";

export default function SponsorDashboard() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [loading, setLoading] = useState(true);
  const [sponsor, setSponsor] = useState<Sponsor | null>(null);
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [showSubmissionDetails, setShowSubmissionDetails] = useState(false);
  const [selectedSubmission, setSelectedSubmission] =
    useState<BountySubmission | null>(null);
  const [selectedBounty, setSelectedBounty] = useState<Bounty | null>(null);

  // Transfer ownership state
  const [transferUsername, setTransferUsername] = useState("");
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferError, setTransferError] = useState("");
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);

  // God mode state
  const [isGod, setIsGod] = useState(false);
  const [allSponsors, setAllSponsors] = useState<
    {
      id: string;
      name: string;
      slug: string | null;
      logo_url: string | null;
      is_verified: number;
      is_banned: number;
    }[]
  >([]);
  const [godSponsorSearch, setGodSponsorSearch] = useState("");

  // Pagination states
  const [bountiesPage, setBountiesPage] = useState(1);
  const [submissionsPage, setSubmissionsPage] = useState(1);
  const [bountiesTabPage, setBountiesTabPage] = useState(1);
  const [submissionsTabPage, setSubmissionsTabPage] = useState(1);
  const ITEMS_PER_PAGE = 5;
  const TAB_ITEMS_PER_PAGE = 10;

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
  }, []);

  const handleTransferOwnership = async () => {
    if (!sponsor || !transferUsername.trim()) return;
    setTransferLoading(true);
    setTransferError("");
    try {
      const res = await fetch(`/api/sponsors/${sponsor.id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ new_owner_username: transferUsername.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTransferError(data.error || "Transfer failed");
        return;
      }
      router.push("/bounty");
    } catch {
      setTransferError("Transfer failed. Please try again.");
    } finally {
      setTransferLoading(false);
    }
  };

  const handleViewBounty = useCallback(
    (bountyId: string) => {
      router.push(`/bounty/${bountyId}`);
    },
    [router],
  );

  const handleEditBounty = useCallback(
    (bountyId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      router.push(`/bounty/edit/${bountyId}`);
    },
    [router],
  );

  const handleRepublish = useCallback(
    (bounty: Bounty, e: React.MouseEvent) => {
      e.stopPropagation();
      router.push(`/bounty/create/manual?copy_from=${bounty.id}`);
    },
    [router],
  );

  const [publishingId, setPublishingId] = useState<string | null>(null);

  /**
   * Take a draft live.
   *
   * The endpoint is a conditional UPDATE, so a double click cannot publish
   * twice — the second request comes back 409 and is reported as "already
   * published" rather than as a failure. A 400 means the draft is still
   * missing required fields, and the server's message names them.
   */
  const handlePublish = useCallback(
    async (bounty: Bounty, e: React.MouseEvent) => {
      e.stopPropagation();
      if (publishingId) return;
      setPublishingId(bounty.id);

      try {
        const res = await fetch(`/api/bounties/${bounty.id}/publish`, {
          method: "POST",
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            data?.error ||
              (res.status === 400
                ? "This draft is missing required fields."
                : "Failed to publish."),
          );
        }

        toast.success("Bounty published");
        setBounties((prev) =>
          prev.map((b) =>
            b.id === bounty.id
              ? {
                  ...b,
                  is_published: 1,
                  published_at: data?.bounty?.published_at,
                }
              : b,
          ),
        );
      } catch (err: any) {
        toast.error(err?.message || "Failed to publish.");
      } finally {
        setPublishingId(null);
      }
    },
    [publishingId],
  );

  const viewSubmission = useCallback(
    (submission: any, bountyId: string, skipUrlUpdate = false) => {
      // Field names now match the API, so the submission passes straight
      // through. This used to be a rename table between the type's invented
      // names and the real ones -- and `reviewed_at` read `completed_at`,
      // which no endpoint sends, so the review date was always blank.
      const bountySubmission: any = {
        ...submission,
        bounty_id: bountyId,
        submitted_by: submission.user_id,
      };

      // Find the associated bounty
      const bounty = bounties.find((b) => b.id === bountyId) || null;

      setSelectedSubmission(bountySubmission);
      setSelectedBounty(bounty);
      setShowSubmissionDetails(true);

      // Update URL with submission ID (unless already from URL)
      if (!skipUrlUpdate) {
        router.push(
          `/bounty/sponsor/dashboard?submission=${submission.id}`,
          undefined,
          { shallow: true },
        );
      }
    },
    [bounties, router],
  );

  const closeSubmissionModal = useCallback(() => {
    setShowSubmissionDetails(false);
    setSelectedSubmission(null);
    setSelectedBounty(null);
    // Remove submission from URL
    router.push("/bounty/sponsor/dashboard", undefined, { shallow: true });
  }, [router]);

  const handleSelectBounty = useCallback(
    (bounty: Bounty) => {
      router.push(`/bounty/${bounty.id}`);
    },
    [router],
  );

  const formatDate = (date: string | number) => {
    // Handle Unix timestamp in seconds (convert to milliseconds)
    const timestamp = typeof date === "number" ? date : Number(date);
    const dateObj =
      !isNaN(timestamp) && timestamp < 10000000000
        ? new Date(timestamp * 1000)
        : new Date(date);
    return dateObj.toLocaleDateString();
  };

  /**
   * Display status for a bounty.
   *
   * Delegates to the shared derivation the worker also uses, so the dashboard
   * and the rest of the site cannot disagree. The previous local version
   * inferred everything from end_date plus submission review state, which
   * predates the is_published / is_winners_announced columns and therefore
   * had no way to show a draft at all.
   *
   * Payment counts come from the submissions already loaded here, which is
   * what lets the dashboard distinguish "Payment Pending" from "Completed".
   */
  const bountyStatusOf = (bounty: Bounty): BountyDisplayStatus => {
    const mine = allSubmissions.filter((s) => s.bounty_id === bounty.id);
    const winners = mine.filter((s) => (s as any).is_winner);
    return getBountyDisplayStatus(
      bounty,
      {
        winnerCount: winners.length,
        paidCount: winners.filter((s) => (s as any).is_paid).length,
      },
      Date.now(),
    );
  };

  /**
   * Badge colours follow DESIGN_SYSTEM.md's semantic rules:
   * green for accepting-submissions, red for negative/action-overdue,
   * orange for the achievement-like end state, neutral for the merely
   * informational ones.
   */
  const getStatusBadgeStyle = (status: BountyDisplayStatus) => {
    switch (status) {
      case "In Progress":
        return "bg-accessible-green/20 text-accessible-green";
      case "Completed":
        return "bg-orange/10 text-orange";
      case "Payment Pending":
        return "bg-red-500/10 text-red-500";
      case "Cancelled":
        return "bg-red-500/10 text-red-500";
      case "Draft":
      case "Unpublished":
      case "In Review":
      default:
        return "bg-smoked-white dark:bg-light-black text-light-charcoal dark:text-lightgrey";
    }
  };

  const getInitials = (username: string) => {
    return username
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase())
      .join("");
  };

  const getBountyTitle = (bountyId: string) => {
    const bounty = bounties.find((b) => b.id === bountyId);
    return bounty ? bounty.title : "Unknown Bounty";
  };

  const refreshSubmissions = useCallback(async () => {
    if (!sponsor) return;

    try {
      // Fetch fresh dashboard data
      const dashboardResponse = await fetch(
        `/api/sponsors/${sponsor.id}/dashboard`,
      );

      if (dashboardResponse.ok) {
        const dashboardData = await dashboardResponse.json();

        const transformedSubmissions: Submission[] = (
          dashboardData.submissions || []
        ).map((s: any) => ({
          id: s.id,
          title: submissionTitle(s.description),
          description: s.description || "",
          submission_url: s.submission_url,
          user_username: s.user_username || null,
          user_name: s.user_username || "Anonymous",
          user_avatar_url: s.user_avatar_url || "",
          user_id: s.user_id || s.submitted_by,
          user_wallet_address: s.user_wallet_address || "",
          bounty_id: s.bounty_id,
          bounty_title: s.bounty_title,
          sponsor_id: sponsor.id,
          status: s.status,
          reviewer_notes: s.reviewer_notes || null,
          transaction_hash: s.transaction_hash || null,
        }));

        setAllSubmissions(transformedSubmissions);
      }
    } catch (error) {
      console.error("Error refreshing submissions:", error);
    }
  }, [sponsor]);

  // Handle submission query parameter to open specific submission.
  // Intentionally excludes allSubmissions and showSubmissionDetails from deps
  // to prevent a race condition where refreshSubmissions() triggers a re-open
  // after the modal has just been closed.
  useEffect(() => {
    const submissionId = router.query.submission as string;
    if (!submissionId || loading || showSubmissionDetails) return;
    if (allSubmissions.length === 0) return;
    const submission = allSubmissions.find((s) => s.id === submissionId);
    if (submission) {
      viewSubmission(submission, submission.bounty_id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.submission, loading]);

  useEffect(() => {
    async function fetchSponsorData() {
      if (!session?.user?.id) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);

        // First, get the sponsor ID for this user
        const sponsorResponse = await fetch(
          `/api/sponsors/user/${session.user.id}`,
        );

        if (!sponsorResponse.ok) {
          console.error("Not a sponsor or sponsor not found");
          setSponsor(null);
          setLoading(false);
          return;
        }

        const sponsorData = await sponsorResponse.json();

        // Handle god mode
        if (sponsorData.is_god) {
          setIsGod(true);
          setAllSponsors(sponsorData.all_sponsors || []);
          if (!sponsorData.sponsor) {
            // God user with no own sponsor — show picker, don't load dashboard
            setLoading(false);
            return;
          }
        }

        const sponsorId = sponsorData.sponsor?.id;
        if (!sponsorId) {
          setSponsor(null);
          setLoading(false);
          return;
        }

        // Get full dashboard data
        const dashboardResponse = await fetch(
          `/api/sponsors/${sponsorId}/dashboard`,
        );

        if (!dashboardResponse.ok) {
          throw new Error("Failed to fetch dashboard data");
        }

        const dashboardData = await dashboardResponse.json();

        // Transform data to match frontend types
        const transformedSponsor: Sponsor = {
          ...dashboardData.sponsor,
          is_verified: dashboardData.sponsor.is_verified === 1,
        };

        const transformedSubmissions: Submission[] = (
          dashboardData.submissions || []
        ).map((s: any) => ({
          id: s.id,
          title: submissionTitle(s.description),
          description: s.description || "",
          submission_url: s.submission_url,
          user_username: s.user_username || null,
          user_name: s.user_username || "Anonymous",
          user_avatar_url: s.user_avatar_url || "",
          user_id: s.user_id || s.submitted_by,
          user_wallet_address: s.user_wallet_address || "",
          bounty_id: s.bounty_id,
          bounty_title: s.bounty_title,
          sponsor_id: sponsorId,
          status: s.status,
          reviewer_notes: s.reviewer_notes || null,
          transaction_hash: s.transaction_hash || null,
        }));

        // Count submissions per bounty
        const submissionCountByBounty: Record<string, number> = {};
        transformedSubmissions.forEach((sub) => {
          submissionCountByBounty[sub.bounty_id] =
            (submissionCountByBounty[sub.bounty_id] || 0) + 1;
        });

        const transformedBounties: Bounty[] = (
          dashboardData.bounties || []
        ).map((b: any) => ({
          id: b.id,
          sponsor_id: b.sponsor_id,
          title: b.title,
          description: b.description,
          requirements: b.requirements ? JSON.parse(b.requirements) : [],
          deliverables: b.deliverables ? JSON.parse(b.deliverables) : [],
          skills: b.skills ? JSON.parse(b.skills) : [],
          status: b.status,
          current_submissions: submissionCountByBounty[b.id] || 0,
          end_date: b.end_date,
          start_date: b.start_date,
          reward: {
            amount: parseFloat(b.reward_amount) || 0,
            token: b.reward_currency || "ALPH",
            usd_equivalent: Number(b.reward_usd) || 0,
          },
          denomination: b.denomination === "usd" ? "usd" : "alph",
          reward_type: b.reward_type || "fixed",
          tier_count: b.tier_count || null,
          category: b.category || "Development",
          slug: b.slug ?? null,
          is_published: b.is_published,
          published_at: b.published_at ?? null,
          is_winners_announced: b.is_winners_announced,
          winners_announced_at: b.winners_announced_at ?? null,
          created_at: b.created_at,
          updated_at: b.updated_at,
        }));

        setSponsor(transformedSponsor);
        setBounties(transformedBounties);
        setAllSubmissions(transformedSubmissions);
      } catch (error) {
        console.error("Error fetching sponsor data:", error);
        setSponsor(null);
      } finally {
        setLoading(false);
      }
    }

    if (!isPending) {
      fetchSponsorData();
    }
  }, [session?.user?.id, isPending]);

  if (loading || isPending) {
    return (
      <Layout title="Sponsor Dashboard - Alphland">
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-orange border-t-transparent mx-auto" />
            <div className="text-xl font-semibold mt-4">Loading...</div>
          </div>
        </div>
      </Layout>
    );
  }

  // God user with no sponsor loaded yet — show a sponsor picker
  if (!sponsor && isGod) {
    const filteredSponsors = allSponsors.filter(
      (s) =>
        !godSponsorSearch ||
        s.name.toLowerCase().includes(godSponsorSearch.toLowerCase()) ||
        (s.slug || "").toLowerCase().includes(godSponsorSearch.toLowerCase()),
    );
    const switchToSponsor = async (sponsorId: string) => {
      setLoading(true);
      try {
        await fetch("/api/god/current-sponsor", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sponsor_id: sponsorId }),
        });
        const dashboardResponse = await fetch(
          `/api/sponsors/${sponsorId}/dashboard`,
        );
        if (!dashboardResponse.ok) throw new Error("Failed to load dashboard");
        const dashboardData = await dashboardResponse.json();
        setSponsor({
          ...dashboardData.sponsor,
          is_verified: dashboardData.sponsor.is_verified === 1,
        });
        const godSubmissions = (dashboardData.submissions || []).map(
          (s: any) => ({
            id: s.id,
            title: submissionTitle(s.description),
            description: s.description || "",
            submission_url: s.submission_url,
            user_username: s.user_username || null,
            user_name: s.user_username || "Anonymous",
            user_avatar_url: s.user_avatar_url || "",
            user_id: s.user_id || s.submitted_by,
            user_wallet_address: s.user_wallet_address || "",
            bounty_id: s.bounty_id,
            bounty_title: s.bounty_title,
            sponsor_id: sponsorId,
            status: s.status,
            reviewer_notes: s.reviewer_notes || null,
            transaction_hash: s.transaction_hash || null,
          }),
        );
        const godSubmissionCountByBounty: Record<string, number> = {};
        godSubmissions.forEach((s: any) => {
          godSubmissionCountByBounty[s.bounty_id] =
            (godSubmissionCountByBounty[s.bounty_id] || 0) + 1;
        });
        setBounties(
          (dashboardData.bounties || []).map((b: any) => ({
            ...b,
            requirements: b.requirements ? JSON.parse(b.requirements) : [],
            deliverables: b.deliverables ? JSON.parse(b.deliverables) : [],
            skills: b.skills ? JSON.parse(b.skills) : [],
            current_submissions: godSubmissionCountByBounty[b.id] || 0,
          })),
        );
        setAllSubmissions(godSubmissions);
      } catch (err) {
        console.error("Failed to switch sponsor:", err);
      } finally {
        setLoading(false);
      }
    };

    return (
      <Layout title="Sponsor Dashboard - Alphland">
        <div className="min-h-screen bg-gradient-to-br from-smoked-white to-white dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4">
          <div className="w-full max-w-lg space-y-4">
            <div className="text-center">
              <span className="inline-block px-3 py-1 rounded-full text-xs font-bold bg-purple-500/15 text-purple-400 border border-purple-400/30 mb-2">
                GOD MODE
              </span>
              <h2 className="text-2xl font-bold text-light-black dark:text-white font-barlow">
                Select a Sponsor
              </h2>
              <p className="text-light-charcoal dark:text-lightgrey text-sm mt-1">
                You have access to all sponsor dashboards.
              </p>
            </div>
            <input
              type="text"
              placeholder="Search sponsors..."
              value={godSponsorSearch}
              onChange={(e) => setGodSponsorSearch(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-border-grey dark:border-dark-charcoal bg-white dark:bg-light-black text-sm focus:outline-none focus:ring-2 focus:ring-orange/40"
            />
            <div className="max-h-96 overflow-y-auto space-y-2">
              {filteredSponsors.map((s) => (
                <button
                  key={s.id}
                  onClick={() => switchToSponsor(s.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-white dark:bg-light-black border border-border-grey dark:border-dark-charcoal hover:border-orange/50 transition-colors text-left"
                >
                  {s.logo_url ? (
                    <img
                      src={s.logo_url}
                      alt={s.name}
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-orange/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold text-orange">
                        {s.name.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-light-black dark:text-white truncate">
                      {s.name}
                    </p>
                    {s.slug && (
                      <p className="text-xs text-light-charcoal truncate">
                        /bounty/sponsor/{s.slug}
                      </p>
                    )}
                  </div>
                  {s.is_verified === 1 && (
                    <span className="ml-auto text-xs text-accessible-green flex-shrink-0">
                      Verified
                    </span>
                  )}
                </button>
              ))}
              {filteredSponsors.length === 0 && (
                <p className="text-center text-sm text-light-charcoal py-4">
                  No sponsors found
                </p>
              )}
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  if (!sponsor) {
    return (
      <Layout title="Sponsor Dashboard - Alphland">
        <div className="min-h-screen bg-gradient-to-br from-smoked-white to-white dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4">
          <div className="text-center space-y-4">
            <h2 className="text-2xl font-bold text-orange font-barlow">
              Create Your Sponsor Profile
            </h2>
            <p className="text-light-charcoal dark:text-lightgrey max-w-md">
              Get started managing bounties and tracking submissions
            </p>
            <button
              onClick={() => router.push("/bounty/sponsor")}
              className="mt-4 bg-orange hover:bg-orange/90 text-white font-barlow font-medium px-6 py-2 rounded-lg"
            >
              Create Profile
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Sponsor Dashboard - Alphland">
      <div className="min-h-screen bg-smoked-white dark:bg-light-black">
        {/* Hero Header */}
        <section className="relative text-white py-12 px-6 sm:px-8 overflow-hidden">
          {/* Background - Custom banner or default gradient */}
          {sponsor.banner_url ? (
            <Image
              src={sponsor.banner_url}
              alt={`${sponsor.name} banner`}
              layout="fill"
              objectFit="cover"
              priority
              className="absolute inset-0"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-r from-orange to-orange/80" />
          )}
          {/* Overlay for better text readability */}
          <div className="absolute inset-0 bg-black/20" />
          <div className="max-w-7xl mx-auto relative z-10">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-6">
              <div className="space-y-2">
                {isGod && (
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-purple-500/20 text-purple-300 border border-purple-400/30 mb-1">
                    GOD MODE
                  </span>
                )}
                <h1 className="text-4xl sm:text-5xl font-bold font-barlow">
                  Sponsor Dashboard
                </h1>
                <p className="text-xl text-white/90 font-barlow">
                  {sponsor.name}
                </p>
                <p className="text-white/70 font-barlow">
                  Manage bounties, track submissions, and reward contributors
                </p>
              </div>
              <div className="flex items-center gap-3">
                {isGod && (
                  <button
                    onClick={() => setSponsor(null)}
                    className="bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 font-barlow font-semibold px-4 py-3 text-sm shadow-lg rounded-lg flex items-center gap-2 whitespace-nowrap border border-purple-400/30"
                  >
                    Switch Sponsor
                  </button>
                )}
                <button
                  onClick={() => router.push("/bounty/create")}
                  disabled={
                    sponsor.status === "pending" || sponsor.is_banned === 1
                  }
                  className="bg-white dark:bg-hero-dark text-orange dark:text-white font-barlow font-semibold px-6 py-3 text-base shadow-lg rounded-lg flex items-center gap-2 whitespace-nowrap border border-orange dark:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-smoked-white dark:hover:bg-light-black disabled:hover:bg-white dark:disabled:hover:bg-hero-dark"
                >
                  <Plus className="w-5 h-5" />
                  New Listing
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="max-w-7xl mx-auto px-6 sm:px-8 py-8 space-y-8">
          {/* Banned banner */}
          {sponsor.is_banned === 1 && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-red-800 dark:text-red-300 font-barlow text-sm">
                  Your account has been banned and cannot publish bounties
                </p>
                <p className="text-red-700 dark:text-red-400 text-sm font-barlow mt-1">
                  If you have any questions, please contact the admin.
                </p>
                <a
                  href="mailto:alph.land@alephium.org"
                  className="inline-flex items-center gap-1.5 mt-2 text-red-600 dark:text-red-400 text-sm font-barlow font-medium hover:underline"
                >
                  <Mail className="w-3.5 h-3.5" />
                  alph.land@alephium.org
                </a>
              </div>
            </div>
          )}

          {/* Pending verification banner */}
          {sponsor.status === "pending" && (
            <div className="bg-orange/5 dark:bg-orange/10 border border-orange/25 dark:border-orange/30 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-orange flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-black dark:text-white font-barlow text-sm">
                  Verification required before publishing bounties
                </p>
                <p className="text-light-charcoal dark:text-lightgrey text-sm font-barlow mt-1">
                  Your sponsor profile is awaiting admin approval. Contact us to
                  complete verification and unlock bounty publishing.
                </p>
                <a
                  href="mailto:alph.land@alephium.org"
                  className="inline-flex items-center gap-1.5 mt-2 text-orange text-sm font-barlow font-medium hover:underline"
                >
                  <Mail className="w-3.5 h-3.5" />
                  alph.land@alephium.org
                </a>
              </div>
            </div>
          )}

          {/* Stats Overview - 3 Column Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Total Bounties Card */}
            <div className="bg-white dark:bg-hero-dark rounded-xl border border-orange/10 dark:border-orange/20 p-6 hover:border-orange/30 transition-all duration-300 hover:shadow-lg">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-light-charcoal dark:text-lightgrey font-barlow font-medium text-sm uppercase tracking-wide">
                    Total Bounties
                  </p>
                  <h3 className="text-3xl sm:text-4xl font-bold text-orange font-barlow">
                    {sponsor.total_bounties_count}
                  </h3>
                </div>
                <div className="w-14 h-14 bg-gradient-to-br from-orange/20 to-orange/10 rounded-lg flex items-center justify-center">
                  <CircleDollarSign className="w-7 h-7 text-orange" />
                </div>
              </div>
              <p className="text-xs text-light-charcoal dark:text-lightgrey mt-3 font-barlow">
                Active and completed listings
              </p>
            </div>

            {/* Total Projects Card */}
            {/* <div className="bg-white dark:bg-hero-dark rounded-xl border border-accessible-green/10 dark:border-accessible-green/20 p-6 hover:border-accessible-green/30 transition-all duration-300 hover:shadow-lg">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-light-charcoal dark:text-lightgrey font-barlow font-medium text-sm uppercase tracking-wide">
                    Total Projects
                  </p>
                  <h3 className="text-3xl sm:text-4xl font-bold text-light-charcoal dark:text-white font-barlow">
                    {sponsor.total_projects_count}
                  </h3>
                </div>
                <div className="w-14 h-14 bg-gradient-to-br from-accessible-green/20 to-accessible-green/10 rounded-lg flex items-center justify-center">
                  <BarChart3 className="w-7 h-7 text-accessible-green" />
                </div>
              </div>
              <p className="text-xs text-light-charcoal dark:text-lightgrey mt-3 font-barlow">
                Connected projects
              </p>
            </div> */}

            {/* Total Rewards Card */}
            <div className="bg-white dark:bg-hero-dark rounded-xl border border-orange/10 dark:border-orange/20 p-6 hover:border-orange/30 transition-all duration-300 hover:shadow-lg">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <p className="text-light-charcoal dark:text-lightgrey font-barlow font-medium text-sm uppercase tracking-wide">
                    Total Rewards
                  </p>
                  <h3 className="text-3xl sm:text-4xl font-bold text-orange font-barlow">
                    ${sponsor.total_reward_amount.toLocaleString()}
                  </h3>
                </div>
                <div className="w-14 h-14 bg-gradient-to-br from-orange/20 to-orange/10 rounded-lg flex items-center justify-center">
                  <TrendingUp className="w-7 h-7 text-orange" />
                </div>
              </div>
              <p className="text-xs text-light-charcoal dark:text-lightgrey mt-3 font-barlow">
                Distributed funds
              </p>
            </div>
          </div>

          {/* Main Content Tabs */}
          <div className="space-y-6">
            <div className="border-b border-light-gray dark:border-dark-charcoal">
              <div className="flex gap-2 overflow-x-auto">
                <button
                  onClick={() => handleTabChange("overview")}
                  className={`px-4 py-3 font-barlow font-medium text-sm border-b-2 transition-all duration-300 ${
                    activeTab === "overview"
                      ? "border-orange text-orange"
                      : "border-transparent text-light-charcoal dark:text-lightgrey hover:text-orange"
                  }`}
                >
                  Overview
                </button>
                <button
                  onClick={() => handleTabChange("bounties")}
                  className={`px-4 py-3 font-barlow font-medium text-sm border-b-2 transition-all duration-300 ${
                    activeTab === "bounties"
                      ? "border-orange text-orange"
                      : "border-transparent text-light-charcoal dark:text-lightgrey hover:text-orange"
                  }`}
                >
                  Bounties
                </button>
                <button
                  onClick={() => handleTabChange("submissions")}
                  className={`px-4 py-3 font-barlow font-medium text-sm border-b-2 transition-all duration-300 ${
                    activeTab === "submissions"
                      ? "border-orange text-orange"
                      : "border-transparent text-light-charcoal dark:text-lightgrey hover:text-orange"
                  }`}
                >
                  Submissions
                </button>
              </div>
            </div>

            {/* Overview Tab */}
            {activeTab === "overview" && (
              <div className="space-y-6">
                {/* Profile Section */}
                <div className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-6 space-y-6">
                  <h2 className="text-xl font-bold text-orange font-barlow">
                    Profile Information
                  </h2>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div className="sm:col-span-2">
                      <p className="text-sm font-barlow font-semibold text-light-charcoal dark:text-lightgrey mb-2">
                        Company Name
                      </p>
                      <p className="text-black dark:text-white font-barlow font-semibold text-lg">
                        {sponsor.name || "Not set"}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-barlow font-semibold text-light-charcoal dark:text-lightgrey mb-2">
                        Description
                      </p>
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow leading-relaxed">
                        {sponsor.description || "No description provided"}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-barlow font-semibold text-light-charcoal dark:text-lightgrey mb-2">
                        Website
                      </p>
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                        {sponsor.website ? (
                          <a
                            href={sponsor.website}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-orange hover:underline break-all"
                          >
                            {sponsor.website}
                          </a>
                        ) : (
                          "No website provided"
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-barlow font-semibold text-light-charcoal dark:text-lightgrey mb-2">
                        Twitter
                      </p>
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                        {sponsor.twitter ? (
                          <a
                            href={`https://twitter.com/${sponsor.twitter.replace(
                              "@",
                              "",
                            )}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-orange hover:underline"
                          >
                            {sponsor.twitter}
                          </a>
                        ) : (
                          "No Twitter handle provided"
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-barlow font-semibold text-light-charcoal dark:text-lightgrey mb-2">
                        Logo
                      </p>
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                        {sponsor.logo_url ? "Uploaded" : "Not uploaded"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Recent Bounties & Submissions Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Recent Bounties */}
                  <div className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-6 space-y-4">
                    <h3 className="text-lg font-bold text-orange font-barlow">
                      Recent Bounties
                      <span className="ml-2 text-sm font-normal text-light-charcoal dark:text-lightgrey">
                        ({bounties.length})
                      </span>
                    </h3>
                    {bounties.length === 0 ? (
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                        No bounties found
                      </p>
                    ) : (
                      <>
                        <div className="space-y-3">
                          {bounties
                            .slice(
                              (bountiesPage - 1) * ITEMS_PER_PAGE,
                              bountiesPage * ITEMS_PER_PAGE,
                            )
                            .map((bounty) => (
                              <div
                                key={bounty.id}
                                className="p-4 border border-light-gray dark:border-dark-charcoal rounded-lg hover:border-orange hover:bg-orange/5 transition-all duration-200 cursor-pointer group"
                                onClick={() => handleViewBounty(bounty.id)}
                              >
                                <div className="flex justify-between items-start gap-2">
                                  <div>
                                    <h4 className="font-semibold text-orange font-barlow group-hover:text-orange/80 transition-colors">
                                      {bounty.title}
                                    </h4>
                                    <div className="flex items-center gap-2 mt-2">
                                      {(() => {
                                        const ds = bountyStatusOf(bounty);
                                        return (
                                          <span
                                            className={`text-xs font-barlow font-medium px-2 py-1 rounded ${getStatusBadgeStyle(ds)}`}
                                          >
                                            {ds}
                                          </span>
                                        );
                                      })()}
                                      <span className="text-xs text-light-charcoal dark:text-lightgrey font-barlow">
                                        {bounty.current_submissions} submissions
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex gap-1">
                                    {bountyStatusOf(bounty) === "Draft" ||
                                    bountyStatusOf(bounty) === "Unpublished" ? (
                                      <button
                                        className="text-orange hover:bg-orange/10 p-2 rounded disabled:opacity-50"
                                        title="Publish this draft"
                                        aria-label="Publish this draft"
                                        disabled={publishingId === bounty.id}
                                        onClick={(e) =>
                                          handlePublish(bounty, e)
                                        }
                                      >
                                        <Send className="w-4 h-4" />
                                      </button>
                                    ) : null}
                                    {bounty.status !== "completed" && (
                                      <button
                                        className="text-orange hover:bg-orange/10 p-2 rounded"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleEditBounty(bounty.id, e);
                                        }}
                                      >
                                        <Edit className="w-4 h-4" />
                                      </button>
                                    )}
                                    {(() => {
                                      const ds = bountyStatusOf(bounty);
                                      return ds === "In Review" ||
                                        ds === "Completed" ? (
                                        <button
                                          className="text-orange hover:bg-orange/10 p-2 rounded"
                                          title="Republish"
                                          onClick={(e) =>
                                            handleRepublish(bounty, e)
                                          }
                                        >
                                          <RefreshCw className="w-4 h-4" />
                                        </button>
                                      ) : null;
                                    })()}
                                  </div>
                                </div>
                              </div>
                            ))}
                        </div>
                        {/* Pagination */}
                        {Math.ceil(bounties.length / ITEMS_PER_PAGE) > 1 && (
                          <div className="flex items-center justify-center gap-2 pt-4 border-t border-light-gray dark:border-dark-charcoal">
                            <button
                              onClick={() =>
                                setBountiesPage((p) => Math.max(1, p - 1))
                              }
                              disabled={bountiesPage === 1}
                              className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm text-light-charcoal dark:text-lightgrey px-4 font-barlow">
                              {bountiesPage} /{" "}
                              {Math.ceil(bounties.length / ITEMS_PER_PAGE)}
                            </span>
                            <button
                              onClick={() =>
                                setBountiesPage((p) =>
                                  Math.min(
                                    Math.ceil(bounties.length / ITEMS_PER_PAGE),
                                    p + 1,
                                  ),
                                )
                              }
                              disabled={
                                bountiesPage ===
                                Math.ceil(bounties.length / ITEMS_PER_PAGE)
                              }
                              className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Recent Submissions */}
                  <div className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-6 space-y-4">
                    <h3 className="text-lg font-bold text-orange font-barlow">
                      Recent Submissions
                      <span className="ml-2 text-sm font-normal text-light-charcoal dark:text-lightgrey">
                        ({allSubmissions.length})
                      </span>
                    </h3>
                    {allSubmissions.length === 0 ? (
                      <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                        No submissions found
                      </p>
                    ) : (
                      <>
                        <div className="space-y-3">
                          {allSubmissions
                            .slice(
                              (submissionsPage - 1) * ITEMS_PER_PAGE,
                              submissionsPage * ITEMS_PER_PAGE,
                            )
                            .map((submission) => (
                              <div
                                key={submission.id}
                                className="p-4 border border-light-gray dark:border-dark-charcoal rounded-lg hover:border-accessible-green hover:bg-accessible-green/5 transition-all duration-200 cursor-pointer"
                                onClick={() =>
                                  viewSubmission(
                                    submission,
                                    submission.bounty_id,
                                  )
                                }
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-3 min-w-0">
                                    {submission.user_avatar_url ? (
                                      <Image
                                        src={submission.user_avatar_url}
                                        alt={submission.user_username || "User"}
                                        width={40}
                                        height={40}
                                        className="w-10 h-10 flex-shrink-0 rounded-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-10 h-10 flex-shrink-0 bg-accessible-green rounded-full flex items-center justify-center text-white text-sm font-barlow">
                                        {submission.user_username
                                          ? getInitials(
                                              submission.user_username,
                                            )
                                          : "?"}
                                      </div>
                                    )}
                                    <div className="min-w-0">
                                      <p className="font-semibold text-orange font-barlow truncate">
                                        {submission.user_username ||
                                          "Anonymous"}
                                      </p>
                                      <p className="text-xs text-light-charcoal dark:text-lightgrey font-barlow truncate">
                                        {submission.bounty_title ||
                                          getBountyTitle(
                                            submission.bounty_id,
                                          )}{" "}
                                        • {formatDate(submission.created_at)}
                                      </p>
                                    </div>
                                  </div>
                                  <span
                                    className={`text-xs font-barlow font-medium px-2 py-1 rounded whitespace-nowrap flex-shrink-0 ${
                                      submission.status === "approved"
                                        ? "bg-accessible-green/20 text-light-charcoal"
                                        : submission.status === "rejected"
                                          ? "bg-red-500/20 text-red-500"
                                          : "bg-yellow-500/20 text-yellow-600"
                                    }`}
                                  >
                                    {submission.status}
                                  </span>
                                </div>
                              </div>
                            ))}
                        </div>
                        {/* Pagination */}
                        {Math.ceil(allSubmissions.length / ITEMS_PER_PAGE) >
                          1 && (
                          <div className="flex items-center justify-center gap-2 pt-4 border-t border-light-gray dark:border-dark-charcoal">
                            <button
                              onClick={() =>
                                setSubmissionsPage((p) => Math.max(1, p - 1))
                              }
                              disabled={submissionsPage === 1}
                              className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm text-light-charcoal dark:text-lightgrey px-4 font-barlow">
                              {submissionsPage} /{" "}
                              {Math.ceil(
                                allSubmissions.length / ITEMS_PER_PAGE,
                              )}
                            </span>
                            <button
                              onClick={() =>
                                setSubmissionsPage((p) =>
                                  Math.min(
                                    Math.ceil(
                                      allSubmissions.length / ITEMS_PER_PAGE,
                                    ),
                                    p + 1,
                                  ),
                                )
                              }
                              disabled={
                                submissionsPage ===
                                Math.ceil(
                                  allSubmissions.length / ITEMS_PER_PAGE,
                                )
                              }
                              className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Transfer Ownership — only visible to the actual owner, not god */}
            {/* {activeTab === "overview" && !isGod && (
              <div className="bg-white dark:bg-hero-dark rounded-xl border border-red-200 dark:border-red-900/40 p-6 space-y-4">
                <h2 className="text-base font-bold text-red-500 font-barlow">
                  Transfer Ownership
                </h2>
                <p className="text-sm text-light-charcoal dark:text-lightgrey">
                  Transfer this sponsor account to another user. You will
                  immediately lose access to the dashboard after transfer.
                </p>

                {!showTransferConfirm ? (
                  <button
                    onClick={() => setShowTransferConfirm(true)}
                    className="px-4 py-2 text-sm font-medium text-red-500 border border-red-300 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    Transfer Ownership
                  </button>
                ) : (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={transferUsername}
                      onChange={(e) => {
                        setTransferUsername(e.target.value);
                        setTransferError("");
                      }}
                      placeholder="New owner's username"
                      className="w-full sm:w-80 px-4 py-2 bg-smoked-white dark:bg-light-black border border-border-grey dark:border-dark-charcoal rounded-lg text-black dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
                    />
                    {transferError && (
                      <p className="text-sm text-red-500">{transferError}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={handleTransferOwnership}
                        disabled={transferLoading || !transferUsername.trim()}
                        className="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {transferLoading
                          ? "Transferring..."
                          : "Confirm Transfer"}
                      </button>
                      <button
                        onClick={() => {
                          setShowTransferConfirm(false);
                          setTransferUsername("");
                          setTransferError("");
                        }}
                        className="px-4 py-2 text-sm font-medium text-light-charcoal dark:text-lightgrey border border-border-grey dark:border-dark-charcoal rounded-lg hover:border-orange transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )} */}

            {/* Bounties Tab */}
            {activeTab === "bounties" && (
              <div className="space-y-4">
                {bounties.length === 0 ? (
                  <div className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-12 text-center space-y-4">
                    <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                      No bounties created yet
                    </p>
                    <button
                      onClick={() => router.push("/bounty/create")}
                      disabled={
                        sponsor.status === "pending" || sponsor.is_banned === 1
                      }
                      className="bg-orange hover:bg-orange/90 text-white font-barlow font-medium px-6 py-2 rounded-lg mx-auto disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Create Your First Bounty
                    </button>
                  </div>
                ) : (
                  <>
                    {bounties
                      .slice(
                        (bountiesTabPage - 1) * TAB_ITEMS_PER_PAGE,
                        bountiesTabPage * TAB_ITEMS_PER_PAGE,
                      )
                      .map((bounty) => (
                        <div
                          key={bounty.id}
                          className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-6 hover:border-orange hover:shadow-lg transition-all duration-300 cursor-pointer"
                          onClick={() => handleSelectBounty(bounty)}
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <div className="flex-1">
                              <h3 className="text-lg font-semibold text-orange font-barlow mb-2">
                                {bounty.title}
                              </h3>
                              <div className="flex flex-wrap gap-2 mb-3">
                                {(() => {
                                  const ds = bountyStatusOf(bounty);
                                  return (
                                    <span
                                      className={`text-xs font-barlow font-medium px-2 py-1 rounded ${getStatusBadgeStyle(ds)}`}
                                    >
                                      {ds}
                                    </span>
                                  );
                                })()}
                                <span className="text-xs font-barlow font-medium px-2 py-1 rounded bg-orange/10 text-orange">
                                  {bounty.category}
                                </span>
                              </div>
                              <p className="text-sm text-light-charcoal dark:text-lightgrey font-barlow">
                                {bounty.current_submissions} submissions • Due{" "}
                                {formatDate(bounty.end_date)}
                              </p>
                            </div>
                            <div className="flex items-center justify-between sm:flex-col sm:items-end gap-4">
                              <div className="font-semibold text-orange font-barlow">
                                {formatBountyReward({
                                  denomination: bounty.denomination,
                                  amount: bounty.reward.amount,
                                  token: bounty.reward.token,
                                  usd: bounty.reward.usd_equivalent,
                                })}
                              </div>
                              <div className="flex gap-2">
                                {bountyStatusOf(bounty) === "Draft" ||
                                bountyStatusOf(bounty) === "Unpublished" ? (
                                  <button
                                    className="bg-orange text-white hover:opacity-90 transition-opacity font-barlow px-3 py-1 rounded text-sm flex items-center gap-1 disabled:opacity-50"
                                    disabled={publishingId === bounty.id}
                                    onClick={(e) => handlePublish(bounty, e)}
                                  >
                                    <Send className="w-4 h-4" />
                                    {publishingId === bounty.id
                                      ? "Publishing..."
                                      : "Publish"}
                                  </button>
                                ) : null}
                                {bounty.status !== "completed" && (
                                  <button
                                    className="border border-orange text-orange hover:bg-orange/10 font-barlow px-3 py-1 rounded text-sm flex items-center gap-1"
                                    onClick={(e) =>
                                      handleEditBounty(bounty.id, e)
                                    }
                                  >
                                    <Edit className="w-4 h-4" />
                                    Edit
                                  </button>
                                )}
                                {(() => {
                                  const ds = bountyStatusOf(bounty);
                                  return ds === "In Review" ||
                                    ds === "Completed" ? (
                                    <button
                                      className="border border-orange text-orange hover:bg-orange/10 font-barlow px-3 py-1 rounded text-sm flex items-center gap-1"
                                      onClick={(e) =>
                                        handleRepublish(bounty, e)
                                      }
                                    >
                                      <RefreshCw className="w-4 h-4" />
                                      Republish
                                    </button>
                                  ) : null;
                                })()}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    {/* Pagination */}
                    {Math.ceil(bounties.length / TAB_ITEMS_PER_PAGE) > 1 && (
                      <div className="flex items-center justify-center gap-2 pt-4">
                        <button
                          onClick={() =>
                            setBountiesTabPage((p) => Math.max(1, p - 1))
                          }
                          disabled={bountiesTabPage === 1}
                          className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm text-light-charcoal dark:text-lightgrey px-4 font-barlow">
                          Page {bountiesTabPage} of{" "}
                          {Math.ceil(bounties.length / TAB_ITEMS_PER_PAGE)}
                        </span>
                        <button
                          onClick={() =>
                            setBountiesTabPage((p) =>
                              Math.min(
                                Math.ceil(bounties.length / TAB_ITEMS_PER_PAGE),
                                p + 1,
                              ),
                            )
                          }
                          disabled={
                            bountiesTabPage ===
                            Math.ceil(bounties.length / TAB_ITEMS_PER_PAGE)
                          }
                          className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Submissions Tab */}
            {activeTab === "submissions" && (
              <div className="space-y-4">
                {allSubmissions.length === 0 ? (
                  <div className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-12 text-center">
                    <p className="text-light-charcoal dark:text-lightgrey font-barlow">
                      No submissions yet. Create bounties to receive
                      submissions.
                    </p>
                  </div>
                ) : (
                  <>
                    {allSubmissions
                      .slice(
                        (submissionsTabPage - 1) * TAB_ITEMS_PER_PAGE,
                        submissionsTabPage * TAB_ITEMS_PER_PAGE,
                      )
                      .map((submission) => (
                        <div
                          key={submission.id}
                          className="bg-white dark:bg-hero-dark rounded-xl border border-light-gray dark:border-dark-charcoal p-6 hover:border-orange hover:shadow-lg transition-all duration-300 cursor-pointer"
                          onClick={() =>
                            viewSubmission(submission, submission.bounty_id)
                          }
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                            <div className="flex items-center gap-4 min-w-0">
                              {submission.user_avatar_url ? (
                                <Image
                                  src={submission.user_avatar_url}
                                  alt={submission.user_username || "User"}
                                  width={48}
                                  height={48}
                                  className="w-12 h-12 flex-shrink-0 rounded-full object-cover"
                                />
                              ) : (
                                <div className="w-12 h-12 flex-shrink-0 bg-orange rounded-full flex items-center justify-center text-white font-barlow font-semibold">
                                  {submission.user_username
                                    ? getInitials(submission.user_username)
                                    : "?"}
                                </div>
                              )}
                              <div className="min-w-0">
                                <h4 className="font-semibold text-orange font-barlow">
                                  {submission.bounty_title ||
                                    getBountyTitle(submission.bounty_id)}
                                </h4>
                                <p className="text-sm text-light-charcoal dark:text-lightgrey font-barlow truncate">
                                  {submission.user_username || "Anonymous"} •{" "}
                                  {formatDate(submission.created_at)}
                                </p>
                              </div>
                            </div>
                            <span
                              className={`text-xs font-barlow font-medium px-3 py-1 rounded whitespace-nowrap ${
                                submission.status === "approved"
                                  ? "bg-accessible-green/20 text-light-charcoal"
                                  : submission.status === "rejected"
                                    ? "bg-red-500/20 text-red-500"
                                    : "bg-yellow-500/20 text-yellow-600"
                              }`}
                            >
                              {submission.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    {/* Pagination */}
                    {Math.ceil(allSubmissions.length / TAB_ITEMS_PER_PAGE) >
                      1 && (
                      <div className="flex items-center justify-center gap-2 pt-4">
                        <button
                          onClick={() =>
                            setSubmissionsTabPage((p) => Math.max(1, p - 1))
                          }
                          disabled={submissionsTabPage === 1}
                          className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="text-sm text-light-charcoal dark:text-lightgrey px-4 font-barlow">
                          Page {submissionsTabPage} of{" "}
                          {Math.ceil(
                            allSubmissions.length / TAB_ITEMS_PER_PAGE,
                          )}
                        </span>
                        <button
                          onClick={() =>
                            setSubmissionsTabPage((p) =>
                              Math.min(
                                Math.ceil(
                                  allSubmissions.length / TAB_ITEMS_PER_PAGE,
                                ),
                                p + 1,
                              ),
                            )
                          }
                          disabled={
                            submissionsTabPage ===
                            Math.ceil(
                              allSubmissions.length / TAB_ITEMS_PER_PAGE,
                            )
                          }
                          className="p-2 rounded-lg border border-light-gray dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Submission Review Modal */}
        <SubmissionReviewModal
          isOpen={showSubmissionDetails}
          onClose={closeSubmissionModal}
          submission={selectedSubmission}
          bounty={selectedBounty}
          onSuccess={refreshSubmissions}
        />
      </div>
    </Layout>
  );
}
