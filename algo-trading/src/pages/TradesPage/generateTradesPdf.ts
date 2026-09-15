import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { TradesFilters } from './tradesQuery'

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS — unchanged from original
// ─────────────────────────────────────────────────────────────────────────────

export type TradeReportData = {
    _id: string
    strategyId?: {
        _id: string
        name: string
    }
    index: string
    premium: number
    qty: number
    buyPrice: number
    exitPrice?: number
    pnl?: number
    exitReason?: string
    createdAt: string
}

export type TradesAnalytics = {
    totalPnl: number
    totalTrades: number
    taxes: number
    netPnl: number
}

type GeneratePdfParams = {
    trades: TradeReportData[]
    filters: TradesFilters
    strategyName?: string
    analytics?: TradesAnalytics
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS — formatting only, zero business logic change
// ─────────────────────────────────────────────────────────────────────────────

/** Format a date string to readable IST format */
const formatDate = (dateString: string) => {
    try {
        const date = new Date(dateString)
        if (isNaN(date.getTime())) return dateString
        return date.toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })
    } catch {
        return dateString
    }
}

/**
 * Format currency for PDF.
 * jsPDF's built-in Helvetica font does NOT support the UTF-8 rupee symbol ₹.
 * Replace with "INR " prefix to keep output clean.
 */
const fmtCurrency = (amount: number): string => {
    const formatted = Math.abs(amount)
        .toFixed(2)
        .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return amount < 0 ? `(INR ${formatted})` : `INR ${formatted}`
}

// ─────────────────────────────────────────────────────────────────────────────
// COLOR PALETTE
// ─────────────────────────────────────────────────────────────────────────────

const C = {
    primary:       [10,  37,  64] as [number, number, number],  // Premium Deep Blue/Navy
    primaryLight:  [30,  57,  84] as [number, number, number],  
    accent:        [21, 101, 192] as [number, number, number],  
    dark:          [18,  18,  22] as [number, number, number],  
    bodyText:      [33,  37,  41] as [number, number, number],  // Off-black body
    subText:       [108, 117, 125] as [number, number, number], // Muted subtext
    headerFill:    [248, 249, 250] as [number, number, number], // Clean off-white
    altRow:        [252, 253, 254] as [number, number, number], // Subtle alt row
    border:        [222, 226, 230] as [number, number, number], // Premium Light Border
    success:       [9,  135,  87] as [number, number, number],  // Zerodha Green
    danger:        [211, 47,  47] as [number, number, number],  // Upstox Red
    orange:        [230,  81,   0] as [number, number, number],  // Warm amber/active
    white:         [255, 255, 255] as [number, number, number],
    divider:       [222, 226, 230] as [number, number, number],
    sectionLabel:  [10,  37,  64] as [number, number, number],
}

// ─────────────────────────────────────────────────────────────────────────────
// DRAWING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function drawSectionLabel(doc: jsPDF, text: string, x: number, y: number) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8.5)
    doc.setTextColor(...C.sectionLabel)
    doc.text(text.toUpperCase(), x, y)
}

function drawDivider(doc: jsPDF, y: number, pageWidth: number, margin = 10) {
    doc.setDrawColor(...C.divider)
    doc.setLineWidth(0.3)
    doc.line(margin, y, pageWidth - margin, y)
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — Portrait layout for readable display on mobile devices
// ─────────────────────────────────────────────────────────────────────────────

export function generateTradesPdf({ trades, analytics }: GeneratePdfParams) {
    const doc = new jsPDF({
        orientation: 'portrait',  // Changed to portrait to look big and clear on mobile screens
        unit: 'mm',
        format: 'a4'
    })

    const pageWidth  = doc.internal.pageSize.getWidth()   // 210mm
    const pageHeight = doc.internal.pageSize.getHeight()  // 297mm
    const ML = 10   // margins optimized for portrait width
    const MR = 10   
    const contentW = pageWidth - ML - MR                 // 190mm

    // ── Data calculations (identical to original) ────────────────────────────
    const completedTrades = trades.filter(t => t.pnl !== undefined)
    const winningTrades   = completedTrades.filter(t => (t.pnl || 0) > 0).length
    const losingTrades    = completedTrades.filter(t => (t.pnl || 0) < 0).length
    const winRateVal      = completedTrades.length > 0
        ? ((winningTrades / completedTrades.length) * 100).toFixed(1)
        : '0.0'
    const grossPnlVal = analytics
        ? analytics.totalPnl
        : trades.reduce((acc, t) => acc + (t.pnl || 0), 0)
    const taxesVal  = analytics ? analytics.taxes : (trades.length * 60)
    const netPnlVal = analytics ? analytics.netPnl : (grossPnlVal - taxesVal)

    let y = 0

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 1 — HEADER BAR
    // ═══════════════════════════════════════════════════════════════════════

    // Full-width dark navy header bar
    doc.setFillColor(...C.primary)
    doc.rect(0, 0, pageWidth, 22, 'F')

    // Logo text
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.setTextColor(...C.white)
    doc.text('OptionAlgo', ML, 13)

    // Logo underscore accent
    doc.setDrawColor(79, 130, 204)
    doc.setLineWidth(0.8)
    doc.line(ML, 15, ML + 34, 15)

    // Report subtitle
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(180, 210, 255)
    doc.text('TRADING HISTORY REPORT', ML, 19.5)

    // Generated on — right aligned
    const genDate = new Date().toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    })
    doc.setFontSize(7.5)
    doc.setTextColor(200, 220, 255)
    doc.text(`Generated: ${genDate}`, pageWidth - MR, 11, { align: 'right' })

    // Confidential badge
    doc.setFillColor(255, 255, 255, 0.12)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.setTextColor(200, 220, 255)
    doc.text('CONFIDENTIAL', pageWidth - MR, 17.5, { align: 'right' })

    y = 28

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 2 — SUMMARY METRICS (2-row premium grid for portrait)
    // ═══════════════════════════════════════════════════════════════════════

    drawSectionLabel(doc, 'Summary Metrics', ML, y)
    y += 2
    doc.setDrawColor(...C.primary)
    doc.setLineWidth(0.5)
    doc.line(ML, y, ML + 32, y)
    y += 4

    // Split metrics into two rows for portrait layout:
    // Row 1: Quantity / Counts (4 cards)
    const metricsRow1 = [
        { label: 'Total Trades',   value: trades.length.toString(), color: C.primary },
        { label: 'Winning Trades', value: winningTrades.toString(), color: C.success },
        { label: 'Losing Trades',  value: losingTrades.toString(),  color: C.danger  },
        { label: 'Win Rate',       value: `${winRateVal}%`,         color: parseFloat(winRateVal) >= 50 ? C.success : C.orange }
    ]

    // Row 2: Financial P&L (3 cards)
    const metricsRow2 = [
        { label: 'Gross P&L',         value: fmtCurrency(grossPnlVal), color: grossPnlVal >= 0 ? C.success : C.danger },
        { label: 'Est. Taxes & Fees', value: fmtCurrency(taxesVal),    color: C.orange },
        { label: 'Net P&L',           value: fmtCurrency(netPnlVal),   color: netPnlVal >= 0 ? C.success : C.danger }
    ]

    const cardH   = 15
    const cardGap = 2

    // Render Row 1 (4 columns)
    const cardW1 = contentW / 4
    metricsRow1.forEach((m, i) => {
        const cx = ML + i * cardW1
        doc.setFillColor(...C.white)
        doc.setDrawColor(...C.border)
        doc.setLineWidth(0.3)
        doc.roundedRect(cx, y, cardW1 - cardGap, cardH, 1, 1, 'FD')

        doc.setFillColor(...m.color)
        doc.rect(cx, y, 1.2, cardH, 'F')

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(6.5)
        doc.setTextColor(...C.subText)
        doc.text(m.label, cx + 4, y + 5.5)

        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.setTextColor(...m.color)
        doc.text(m.value, cx + 4, y + 11.5)
    })

    y += cardH + 2.5

    // Render Row 2 (3 columns)
    const cardW2 = contentW / 3
    metricsRow2.forEach((m, i) => {
        const cx = ML + i * cardW2
        doc.setFillColor(...C.white)
        doc.setDrawColor(...C.border)
        doc.setLineWidth(0.3)
        doc.roundedRect(cx, y, cardW2 - cardGap, cardH, 1, 1, 'FD')

        doc.setFillColor(...m.color)
        doc.rect(cx, y, 1.2, cardH, 'F')

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(6.5)
        doc.setTextColor(...C.subText)
        doc.text(m.label, cx + 4, y + 5.5)

        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8.5)
        doc.setTextColor(...m.color)
        doc.text(m.value, cx + 4, y + 11.5)
    })

    y += cardH + 5
    drawDivider(doc, y, pageWidth)
    y += 5

    // ═══════════════════════════════════════════════════════════════════════
    // SECTION 3 — TRADE AUDIT LOG (portrait responsive columns)
    // ═══════════════════════════════════════════════════════════════════════

    drawSectionLabel(doc, 'Trade Audit Log', ML, y)
    y += 2
    doc.setDrawColor(...C.primary)
    doc.setLineWidth(0.5)
    doc.line(ML, y, ML + 28, y)
    y += 4

    // Map trade rows
    const tableRows = trades.map(trade => ({
        createdAt:  formatDate(trade.createdAt),
        strategy:   trade.strategyId?.name || 'Manual',
        index:      trade.index || '-',
        premium:    trade.premium ? trade.premium.toString() : '-',
        qty:        trade.qty.toString(),
        buyPrice:   fmtCurrency(trade.buyPrice),
        exitPrice:  trade.exitPrice !== undefined ? fmtCurrency(trade.exitPrice) : '---',
        pnl:        trade.pnl !== undefined ? fmtCurrency(trade.pnl) : '---',
        exitReason: trade.exitReason || 'Active',
        rawPnl:     trade.pnl
    }))

    autoTable(doc, {
        startY: y,
        head: [['Entry Date & Time', 'Strategy', 'Index', 'Premium', 'Qty',
                'Entry Price', 'Exit Price', 'Total P&L', 'Exit Reason']],
        body: tableRows.map(row => [
            row.createdAt,
            row.strategy,
            row.index,
            row.premium,
            row.qty,
            row.buyPrice,
            row.exitPrice,
            row.pnl,
            row.exitReason
        ]),
        showHead: 'everyPage',
        theme: 'plain',
        headStyles: {
            fillColor:   C.primary,
            textColor:   C.white,
            fontSize:    8,               
            fontStyle:   'bold',
            cellPadding: { top: 3.5, right: 3, bottom: 3.5, left: 3 },
            halign:      'center',
            valign:      'middle'
        },
        bodyStyles: {
            textColor:   C.bodyText,
            fontSize:    7.5,             
            cellPadding: { top: 3, right: 3, bottom: 3, left: 3 },
            valign:      'middle'
        },
        alternateRowStyles: {
            fillColor: C.altRow
        },
        columnStyles: {
            0: { cellWidth: 28, halign: 'left'   },  // Entry Date & Time (wraps cleanly to two lines)
            1: { cellWidth: 24, halign: 'left'   },  // Strategy
            2: { cellWidth: 15, halign: 'center' },  // Index
            3: { cellWidth: 26, halign: 'left'   },  // Premium
            4: { cellWidth: 10, halign: 'right'  },  // Qty
            5: { cellWidth: 22, halign: 'right'  },  // Entry Price
            6: { cellWidth: 22, halign: 'right'  },  // Exit Price
            7: { cellWidth: 24, halign: 'right'  },  // P&L
            8: { cellWidth: 19, halign: 'center' },  // Exit Reason
        },
        didParseCell: (data) => {
            // P&L column coloring
            if (data.section === 'body' && data.column.index === 7) {
                const rawPnl = tableRows[data.row.index]?.rawPnl
                if (rawPnl !== undefined) {
                    data.cell.styles.textColor  = rawPnl >= 0 ? C.success : C.danger
                    data.cell.styles.fontStyle  = 'bold'
                }
            }
            // Exit Reason badge coloring
            if (data.section === 'body' && data.column.index === 8) {
                const reason = data.cell.raw as string
                if (reason === 'Target') {
                    data.cell.styles.textColor = C.success
                    data.cell.styles.fontStyle = 'bold'
                } else if (reason === 'SL' || reason === 'Trailing SL') {
                    data.cell.styles.textColor = C.danger
                    data.cell.styles.fontStyle = 'bold'
                } else if (reason === 'Active') {
                    data.cell.styles.textColor = C.orange
                    data.cell.styles.fontStyle = 'bold'
                } else if (reason === 'Manual') {
                    data.cell.styles.textColor = C.subText
                    data.cell.styles.fontStyle = 'bold'
                }
            }
            // Column header alignment overrides
            if (data.section === 'head') {
                if ([4, 5, 6, 7].includes(data.column.index)) {
                    data.cell.styles.halign = 'right'
                }
            }
        },
        styles: {
            overflow:  'linebreak',
            lineColor: C.border,
            lineWidth: 0.2
        },
        margin: { left: ML, right: MR, bottom: 18 }
    })

    // ═══════════════════════════════════════════════════════════════════════
    // FOOTER — every page
    // ═══════════════════════════════════════════════════════════════════════

    const totalPagesCount = (doc as any).internal.getNumberOfPages()
    for (let i = 1; i <= totalPagesCount; i++) {
        doc.setPage(i)

        // Footer bar
        doc.setFillColor(...C.primary)
        doc.rect(0, pageHeight - 11, pageWidth, 11, 'F')

        // Left — branding
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(7)
        doc.setTextColor(180, 210, 255)
        doc.text('OptionAlgo', ML, pageHeight - 4.5)

        // Center — page number
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7)
        doc.setTextColor(200, 220, 255)
        doc.text(
            `Page ${i} of ${totalPagesCount}`,
            pageWidth / 2,
            pageHeight - 4.5,
            { align: 'center' }
        )

        // Right — confidential
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(6.5)
        doc.setTextColor(160, 190, 230)
        doc.text(
            'Confidential  |  Internal Only',
            pageWidth - MR,
            pageHeight - 4.5,
            { align: 'right' }
        )
    }

    // Save — filename unchanged
    const filename = `OptionAlgo_Trades_Report_${new Date().toISOString().split('T')[0]}.pdf`
    doc.save(filename)
}
