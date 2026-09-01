-- CreateIndex
CREATE INDEX "Ticket_createdAt_idx" ON "Ticket"("createdAt");

-- CreateIndex
CREATE INDEX "Invoice_companyId_periodStart_periodEnd_idx" ON "Invoice"("companyId", "periodStart", "periodEnd");
