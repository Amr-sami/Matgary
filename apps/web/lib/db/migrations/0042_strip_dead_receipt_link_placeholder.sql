-- The {receiptLink} placeholder was a leftover from a planned-then-cancelled
-- public receipt-page feature. Receipts are now delivered as PDF attachments,
-- so the placeholder is dead. After the application code stops passing
-- `receiptLink` to substitute(), any tenant template that still references
-- {receiptLink} would render it as a literal "{receiptLink}" string in the
-- WhatsApp message. This migration strips the dead placeholder (and the
-- surrounding label line in the historical default template) from every
-- tenant's stored message template so output stays clean.
--
-- regexp_replace patterns (run in order):
--   1. The full default-template block:  "لمراجعة الفاتورة الإلكترونية:\n{receiptLink}"
--   2. A common one-line variant:        "رابط الفاتورة: {receiptLink}"
--   3. Same in English:                  "Receipt link: {receiptLink}"
--   4. Any remaining bare placeholder:   "{receiptLink}"
-- Then collapse 3+ consecutive newlines back to 2 and trim trailing whitespace.

UPDATE shop_settings
   SET message_template =
       regexp_replace(
         regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 message_template,
                 E'\\s*لمراجعة الفاتورة الإلكترونية:\\s*\\n?\\s*\\{receiptLink\\}\\s*',
                 '',
                 'g'
               ),
               E'\\s*رابط الفاتورة:\\s*\\{receiptLink\\}\\s*',
               '',
               'g'
             ),
             E'\\s*Receipt link:\\s*\\{receiptLink\\}\\s*',
             '',
             'gi'
           ),
           E'\\{receiptLink\\}',
           '',
           'g'
         ),
         E'\\n{3,}',
         E'\n\n',
         'g'
       )
 WHERE message_template LIKE '%{receiptLink}%';

-- Trim trailing whitespace left by the substitutions above.
UPDATE shop_settings
   SET message_template = rtrim(message_template, E' \\n\\t')
 WHERE message_template ~ E'[ \\n\\t]$';
