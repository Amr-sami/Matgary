import type { Return } from "@/lib/types";
import { formatDate } from "@/lib/utils";

interface ReturnsTableRowProps {
  returnRecord: Return;
}

export function ReturnsTableRow({ returnRecord }: ReturnsTableRowProps) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-3 px-2 text-sm">
        {formatDate(new Date(returnRecord.returnDate))}
      </td>
      <td className="py-3 px-2">
        <div>
          <p className="font-medium">{returnRecord.productName}</p>
        </div>
      </td>
      <td className="py-3 px-2">{returnRecord.returnedQuantity}</td>
      <td className="py-3 px-2 text-sm">{returnRecord.reason}</td>
    </tr>
  );
}