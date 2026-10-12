"use client";

import { apiClient } from "@/lib/api-client";
import { formatBountyReward, sponsorSlug } from "../utils";
import {
  Bookmark,
  Calendar,
  DollarSign,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";

const BOOKMARKS_PER_PAGE = 10;

interface BookmarkItem {
  id: string;
  bounty_id: string;
  sponsor_id: string | null;
  created_at: number;
  title: string;
  reward_amount: number;
  reward_currency: string;
  reward_usd?: number | null;
  denomination?: "alph" | "usd";
  status: string;
  end_date: string;
  sponsor_name: string;
  sponsor_slug?: string;
  sponsor_logo_url: string | null;
}

interface BookmarksSectionProps {
  userId: string;
  isOwnProfile?: boolean;
}

export function BookmarksSection({
  userId,
  isOwnProfile = false,
}: BookmarksSectionProps) {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const fetchBookmarks = async () => {
      try {
        const { bookmarks: data } = await apiClient.getBookmarks(userId);
        // Sort by created_at descending (newest first)
        const sorted = data.sort(
          (a: BookmarkItem, b: BookmarkItem) => b.created_at - a.created_at,
        );
        setBookmarks(sorted);
      } catch (error) {
        console.error("Error fetching bookmarks:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchBookmarks();
  }, [userId]);

  // Pagination logic
  const totalPages = Math.ceil(bookmarks.length / BOOKMARKS_PER_PAGE);
  const startIndex = (currentPage - 1) * BOOKMARKS_PER_PAGE;
  const paginatedBookmarks = bookmarks.slice(
    startIndex,
    startIndex + BOOKMARKS_PER_PAGE,
  );

  if (loading) {
    return (
      <section className="bg-white dark:bg-hero-dark rounded-xl border border-border-grey dark:border-dark-charcoal p-6">
        <div className="flex items-center gap-2 mb-4">
          <Bookmark className="w-5 h-5 text-orange" />
          <h2 className="text-xl font-bold text-black dark:text-white font-barlow">
            Bookmarked Bounties
          </h2>
        </div>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-orange border-t-transparent mx-auto"></div>
          <p className="mt-4 text-light-charcoal dark:text-lightgrey text-sm">
            Loading bookmarks...
          </p>
        </div>
      </section>
    );
  }

  if (bookmarks.length === 0) {
    return (
      <section className="bg-white dark:bg-hero-dark rounded-xl border border-border-grey dark:border-dark-charcoal p-6">
        <div className="flex items-center gap-2 mb-4">
          <Bookmark className="w-5 h-5 text-orange" />
          <h2 className="text-xl font-bold text-black dark:text-white font-barlow">
            Bookmarked Bounties
          </h2>
        </div>
        <div className="text-center py-8">
          <Bookmark className="w-12 h-12 text-light-charcoal mx-auto mb-4 opacity-20" />
          <p className="text-light-charcoal dark:text-lightgrey">
            No bookmarked bounties yet
          </p>
        </div>
      </section>
    );
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  // Determine the display status (check if deadline has passed)
  const getDisplayStatus = (bookmark: BookmarkItem): string => {
    if (bookmark.status === "open" && bookmark.end_date) {
      const endDate = new Date(bookmark.end_date);
      const now = new Date();
      if (endDate < now) {
        return "ended";
      }
    }
    return bookmark.status;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open":
        return "bg-accessible-green/10 text-accessible-green";
      case "ended":
      case "closed":
      case "cancelled":
        return "bg-red-500/10 text-red-500";
      case "completed":
        return "bg-orange/10 text-orange";
      default:
        return "bg-light-charcoal/10 text-light-charcoal";
    }
  };

  const handleRemoveBookmark = async (
    e: React.MouseEvent,
    bountyId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await apiClient.deleteBookmark(userId, bountyId);
      setBookmarks((prev) => prev.filter((b) => b.bounty_id !== bountyId));
    } catch (error) {
      console.error("Error removing bookmark:", error);
    }
  };

  return (
    <section className="bg-white dark:bg-hero-dark rounded-xl border border-border-grey dark:border-dark-charcoal p-6">
      <div className="flex items-center gap-2 mb-4">
        <Bookmark className="w-5 h-5 text-orange" fill="currentColor" />
        <h2 className="text-xl font-bold text-black dark:text-white font-barlow">
          Bookmarked Bounties
        </h2>
        <span className="ml-auto text-sm text-light-charcoal dark:text-lightgrey">
          {bookmarks.length} {bookmarks.length === 1 ? "bounty" : "bounties"}
        </span>
      </div>

      <div className="space-y-4">
        {paginatedBookmarks.map((bookmark) => {
          const displayStatus = getDisplayStatus(bookmark);
          return (
            <div
              key={bookmark.id}
              className="relative p-4 rounded-lg border border-border-grey dark:border-dark-charcoal hover:border-orange hover:shadow-md transition-all duration-300"
            >
              <Link href={`/bounty/${bookmark.bounty_id}`}>
                <a className="flex items-start gap-3">
                  {/* Sponsor Logo */}
                  {bookmark.sponsor_logo_url ? (
                    <Image
                      src={bookmark.sponsor_logo_url}
                      alt={bookmark.sponsor_name}
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-orange/10 flex items-center justify-center flex-shrink-0">
                      <span className="text-orange font-bold text-lg">
                        {bookmark.sponsor_name?.charAt(0).toUpperCase() || "?"}
                      </span>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    {/* Title */}
                    <h3 className="text-base font-semibold text-black dark:text-white font-barlow mb-1 line-clamp-1">
                      {bookmark.title}
                    </h3>

                    {/* Sponsor Name */}
                    <p className="text-sm text-light-charcoal dark:text-lightgrey mb-2">
                      by{" "}
                      {bookmark.sponsor_id && bookmark.sponsor_name ? (
                        <Link
                          href={`/bounty/sponsor/${bookmark.sponsor_slug || sponsorSlug(bookmark.sponsor_name)}`}
                        >
                          <a
                            className="hover:text-orange transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {bookmark.sponsor_name}
                          </a>
                        </Link>
                      ) : (
                        bookmark.sponsor_name
                      )}
                    </p>

                    {/* Meta Info */}
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      {/* Reward */}
                      <div className="flex items-center gap-1 text-accessible-green font-semibold">
                        <DollarSign className="w-3 h-3" />
                        {formatBountyReward({
                          denomination: bookmark.denomination,
                          amount: bookmark.reward_amount,
                          token: bookmark.reward_currency,
                          usd: bookmark.reward_usd,
                        })}
                      </div>

                      {/* End Date */}
                      <div className="flex items-center gap-1 text-light-charcoal dark:text-lightgrey">
                        <Calendar className="w-3 h-3" />
                        {formatDate(bookmark.end_date)}
                      </div>

                      {/* Status */}
                      <span
                        className={`px-2 py-0.5 rounded-full font-medium ${getStatusColor(displayStatus)}`}
                      >
                        {displayStatus.charAt(0).toUpperCase() +
                          displayStatus.slice(1)}
                      </span>
                    </div>
                  </div>
                </a>
              </Link>

              {/* Remove Button */}
              {isOwnProfile && (
                <button
                  onClick={(e) => handleRemoveBookmark(e, bookmark.bounty_id)}
                  className="absolute top-3 right-3 p-1.5 rounded-full text-light-charcoal hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Remove bookmark"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6 pt-4 border-t border-border-grey dark:border-dark-charcoal">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="p-2 rounded-lg border border-border-grey dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-light-charcoal dark:text-lightgrey px-4">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="p-2 rounded-lg border border-border-grey dark:border-dark-charcoal hover:border-orange disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </section>
  );
}
