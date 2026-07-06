// lib/recurrence.js
// Owns: recurrence rule logic — computing the next due date for recurring pacts.
// Does NOT own: pact creation, DB writes, Slack messaging.
//
// Rule shape: { frequency: 'daily'|'weekly'|'biweekly'|'monthly', day?: 0-6, dayOfMonth?: 1-31 }
//   frequency=daily: repeat every day
//   frequency=weekly: repeat on `day` (0=Sun … 6=Sat) each week
//   frequency=biweekly: repeat on `day` every two weeks
//   frequency=monthly: repeat on `dayOfMonth` each month

'use strict';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Compute the next due date after `fromDate` based on `rule`.
 * `fromDate` is either a Date object or an ISO string.
 * Returns a Date (UTC midnight for the computed day).
 *
 * Edge-case: if the pact is overdue, `fromDate` should be today so the next
 * instance falls on today + interval rather than stacking from the missed date.
 */
function nextDueDate(rule, fromDate) {
  if (!rule || !rule.frequency) {
    throw new Error('recurrence.nextDueDate: rule.frequency is required');
  }

  const base = new Date(fromDate);
  // Work in UTC calendar days
  const year  = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day   = base.getUTCDate();

  switch (rule.frequency) {
    case 'daily': {
      return utcDate(year, month, day + 1);
    }

    case 'weekly': {
      const targetDay = Number(rule.day ?? 1); // 0=Sun…6=Sat, default Monday
      return nextWeekday(year, month, day, targetDay, 7);
    }

    case 'biweekly': {
      const targetDay = Number(rule.day ?? 1);
      return nextWeekday(year, month, day, targetDay, 14);
    }

    case 'monthly': {
      // Same day-of-month next month; cap to month end to avoid skipping short months
      const targetDom = Number(rule.dayOfMonth ?? day);
      let nextMonth = month + 1;
      let nextYear  = year;
      if (nextMonth > 11) { nextMonth = 0; nextYear++; }
      const daysInNext = daysInMonth(nextYear, nextMonth);
      const clampedDom = Math.min(targetDom, daysInNext);
      return utcDate(nextYear, nextMonth, clampedDom);
    }

    default:
      throw new Error(`recurrence.nextDueDate: unknown frequency "${rule.frequency}"`);
  }
}

/**
 * Find the next occurrence of `targetDayOfWeek` (0-6) that is at least
 * `minDaysAhead` days after the current date, then snap to the nearest
 * matching weekday on or after that offset.
 *
 * WHY `minDaysAhead`: weekly = 7, biweekly = 14. Without the floor, a
 * Friday-recurring pact completed on Friday would re-due the same day.
 */
function nextWeekday(year, month, day, targetDayOfWeek, minDaysAhead) {
  // Start from base + minDaysAhead
  const earliest = utcDate(year, month, day + minDaysAhead);
  const earliestDow = earliest.getUTCDay();
  const delta = (targetDayOfWeek - earliestDow + 7) % 7;
  return utcDate(
    earliest.getUTCFullYear(),
    earliest.getUTCMonth(),
    earliest.getUTCDate() + delta
  );
}

function utcDate(year, month, day) {
  return new Date(Date.UTC(year, month, day, 12, 0, 0)); // noon UTC avoids DST edge
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Return a human-readable label for a recurrence rule, e.g. "Every Friday".
 */
function recurrenceLabel(rule) {
  if (!rule || !rule.frequency) return '';
  switch (rule.frequency) {
    case 'daily':    return 'Daily';
    case 'weekly':   return `Every ${DAY_NAMES[Number(rule.day ?? 1)]}`;
    case 'biweekly': return `Every other ${DAY_NAMES[Number(rule.day ?? 1)]}`;
    case 'monthly':  return `Monthly (day ${rule.dayOfMonth ?? '?'})`;
    default:         return rule.frequency;
  }
}

module.exports = { nextDueDate, recurrenceLabel };
