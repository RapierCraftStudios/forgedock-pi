import type {
  ReviewPrCoordinator,
  ReviewPrRequest,
  ReviewPrResult,
} from "./review-pr.ts";

export type ReviewPrStagingRequest = Omit<
  ReviewPrRequest,
  "mode" | "autoMergeRequested"
>;

/**
 * Strict deployment-readiness review. It delegates the shared panel and gate
 * machinery, emits an authoritative staging marker, and can never merge or
 * deploy the staging route.
 */
export class ReviewPrStagingCoordinator {
  readonly #review: ReviewPrCoordinator;

  constructor(review: ReviewPrCoordinator) {
    this.#review = review;
  }

  review(input: ReviewPrStagingRequest): Promise<ReviewPrResult> {
    return this.#review.review({
      ...input,
      mode: "staging",
      autoMergeRequested: false,
    });
  }
}
