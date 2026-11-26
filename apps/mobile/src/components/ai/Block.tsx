import type { ai } from "@matgary/api-client";

import { BulkPreviewBubble } from "./BulkPreviewBubble";
import { BulkResultBubble } from "./BulkResultBubble";
import { ChartBubble } from "./ChartBubble";
import { ClarificationBubble } from "./ClarificationBubble";
import { ComparisonBubble } from "./ComparisonBubble";
import { ConfirmationBubble } from "./ConfirmationBubble";
import { EditableImportPreviewBubble } from "./EditableImportPreviewBubble";
import { ImportConflictBubble } from "./ImportConflictBubble";
import { ImportPreviewBubble } from "./ImportPreviewBubble";
import { ImportQuestionBubble } from "./ImportQuestionBubble";
import { ImportResultBubble } from "./ImportResultBubble";
import { InventorySummaryBubble } from "./InventorySummaryBubble";
import { KnowledgeAnswerBubble } from "./KnowledgeAnswerBubble";
import { KpiBubble } from "./KpiBubble";
import { ProductCardBubble } from "./ProductCardBubble";
import { RollbackConflictBubble } from "./RollbackConflictBubble";
import { RollbackPreviewBubble } from "./RollbackPreviewBubble";
import { RollbackResultBubble } from "./RollbackResultBubble";
import { SalesSummaryBubble } from "./SalesSummaryBubble";
import { TableBubble } from "./TableBubble";
import { TextBubble } from "./TextBubble";
import { WarningBubble } from "./WarningBubble";

/**
 * Dispatcher: pick the right renderer for an `AiBlock`. One switch keeps
 * every block kind required at the type level — adding a new kind to the
 * shared `AiBlock` union forces a new case here or TypeScript breaks.
 *
 * `onConfirmResult` fires when a confirmation bubble finishes (tap Confirm →
 * server returned new blocks; tap Cancel → `null`). The chat screen appends
 * the returned blocks as a new assistant turn.
 *
 * `onFollowUp` fires when the user taps a clarification option — the chat
 * screen pushes `text` through its normal `send()` path so F6 context +
 * F5 preview run unchanged.
 */
export interface BlockProps {
  block: ai.AiBlock;
  onConfirmResult?: (blocks: ai.AiBlock[] | null) => void;
  onFollowUp?: (text: string) => void;
  /** F6 — forwarded to ConfirmationBubble so the confirm POST carries the
   *  active conversation id. */
  conversationId?: string;
}

export function Block({ block, onConfirmResult, onFollowUp, conversationId }: BlockProps) {
  switch (block.kind) {
    case "text":
      return <TextBubble block={block} />;
    case "chart":
      return <ChartBubble block={block} />;
    case "table":
      return <TableBubble block={block} />;
    case "kpi":
      return <KpiBubble block={block} />;
    case "product_card":
      return <ProductCardBubble block={block} />;
    case "confirmation":
      return (
        <ConfirmationBubble
          block={block}
          conversationId={conversationId}
          onResult={(blocks) => onConfirmResult?.(blocks)}
        />
      );
    case "clarification":
      return <ClarificationBubble block={block} onFollowUp={onFollowUp} />;
    case "comparison":
      return <ComparisonBubble block={block} />;
    case "inventory_summary":
      return <InventorySummaryBubble block={block} />;
    case "sales_summary":
      return <SalesSummaryBubble block={block} />;
    case "warning":
      return <WarningBubble block={block} />;
    case "knowledge_answer":
      return <KnowledgeAnswerBubble block={block} />;
    case "rollback_preview":
      return <RollbackPreviewBubble block={block} />;
    case "rollback_result":
      return <RollbackResultBubble block={block} />;
    case "rollback_conflict":
      return <RollbackConflictBubble block={block} />;
    case "import_preview":
      return <ImportPreviewBubble block={block} />;
    case "editable_import_preview":
      return <EditableImportPreviewBubble block={block} />;
    case "import_question":
      return <ImportQuestionBubble block={block} />;
    case "import_result":
      return <ImportResultBubble block={block} />;
    case "import_conflict":
      return <ImportConflictBubble block={block} />;
    case "bulk_preview":
      return <BulkPreviewBubble block={block} />;
    case "bulk_result":
      return <BulkResultBubble block={block} />;
  }
}
