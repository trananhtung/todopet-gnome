// When the pet talks (port of Brain.swift's tick body, updateFlow, trackDistraction, runRules and their helpers):
// the reminder rules in Swift's order and timings, the deep-work protection that holds them, the distraction log and
// the mischief that escalates while you slack (grumble → sign parade → block). devAntic(kind) plays a stunt on demand
// (dev scenes, the Developer page) through the same code.
//
// These are Brain methods: brain.js installs them on Brain.prototype with installRules(Brain), so `this` is the
// Brain and the helpers they use (say, _once, _every, _context, _currentMeeting, _isAway, _distraction, ...) are its
// own. Like brain.js, this file imports nothing from GNOME Shell, so plain gjs runs it in the tests.
import {atHour, shortText, timeString} from '../core/dates.js';
import {freeMinutes, nextEvent} from '../core/calendarMath.js';
import {CalmRules} from '../core/calm.js';
import {L} from '../core/l10n.js';
import {LifeRules, distractionTotal, isHungry} from '../core/life.js';
import {Lines} from '../core/lines.js';
import {Mood} from '../core/mood.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// The rules run every 15 seconds, and each round on a distracting app or site adds this much to the day (Swift: 15).
const DISTRACTION_ROUND_SECONDS = 15;

class RuleMethods {
    // Swift's tick() between the hunger and the recompute: time on distracting apps and sites, the end of a block
    // when you left the site, the distraction log and deep work.
    _watchWork(now) {
        const current = this._currentDistraction(now);
        if (this.hasToken && this._context(now).inWork && current)
            this.life.mutate(s => LifeRules.addDistraction(s, current.app, DISTRACTION_ROUND_SECONDS));
        // Left the distracting app or site: the pet gets out of the way.
        if (this.antic?.kind === 'block' && current === null)
            this.endAntic();
        this.trackDistraction(now);
        this.updateFlow(now);
    }

    // Tracks steady typing in work apps; ten minutes of it is "the zone".
    updateFlow(now = this._now()) {
        const sinceKey = this._secondsSinceKey();
        const engaged = CalmRules.engaged(sinceKey, this._idleSeconds(now), this._currentDistraction(now) !== null);
        this.engagedSince = CalmRules.engagedSince(this.engagedSince, engaged, sinceKey, now);
        const inFlow = Boolean(this.prefs.protectFlow) && this.hasToken && CalmRules.inFlow(this.engagedSince, now);
        if (this.flow === inFlow)
            return;
        this.flow = inFlow;
        if (inFlow) {
            this.flowStartedAt = this.engagedSince ?? now;
            this.diary.add('flow', L('Bạn vào guồng (gõ phím đều 10 phút) — pet giữ im lặng',
                "You're in the zone (10 minutes of steady typing) — the pet stays quiet"), {tag: 'flowStart', now});
        } else {
            this.lastFlowEnd = now;
            const minutes = Math.trunc((now - this.flowStartedAt) / MINUTE);
            this.diary.add('flow', L(`Hết guồng sau ${minutes} phút`, `Left the zone after ${minutes} minutes`),
                {tag: 'flowEnd', minutes, now});
        }
        this._changed();
    }

    // Logs how long you stay in each distracting app or site.
    trackDistraction(now = this._now()) {
        const current = this._currentDistraction(now)?.app ?? null;
        const s = this.distractionSession;
        if (s && s.label !== current) {
            const minutes = Math.trunc((now - s.start) / MINUTE);
            if (minutes >= 1) {
                this.diary.add('distraction', L(`Rời ${s.label} sau ${minutes} phút`, `Left ${s.label} after ${minutes} minutes`),
                    {tag: 'end', minutes, now});
            }
            this.distractionSession = null;
        }
        if (current === null)
            return;
        this.distractionSession ??= {label: current, start: now, logged: false};
        const session = this.distractionSession;
        if (!session.logged && now - session.start >= 120 * SECOND) {
            this.diary.add('distraction', L(`Đang ở ${current} hơn 2 phút`, `On ${current} for 2+ minutes`), {now});
            session.logged = true;
        }
    }

    // Decides whether to say something now, and what. At most one bubble per round; `lastRule` names the rule that
    // spoke. Rules below the calm gates wait for a pause and for the bubble gap, and a held one goes to the diary.
    runRules(now = this._now()) {
        this._at(now, () => this._runRules(now));
    }

    _runRules(now) {
        if (this.quietUntil && now < this.quietUntil)
            return;
        if (this.quietUntil) {
            this.quietUntil = null;
            this._changed();
        }

        if (this._isAway(now)) {
            if (this.awaySince === null) {
                this.awaySince = new Date(now.getTime() - this._idleSeconds(now) * SECOND);
                const since = timeString(this.awaySince);
                this.diary.add('system', L(`Bạn rời máy từ ${since} — pet không nhắc gì`, `You stepped away at ${since} — no reminders`),
                    {now});
            }
            return;
        }

        // Meetings come first, even during a focus session; during a meeting the pet stays quiet.
        const e = nextEvent(this.events, now);
        if (e) {
            const mins = (e.start - now) / MINUTE;
            if (mins <= this._prefInt('meetingLead', 0) && this._once(`meeting-${e.id}`, now)) {
                const actions = [];
                if (e.joinURL)
                    actions.push({title: L('Vào họp ↗', 'Join ↗'), primary: true, run: () => this._openURL(e.joinURL)});
                actions.push({title: 'OK'});
                const at = timeString(e.start);
                this._remind('meeting', {
                    text: Lines.meetingSoon(e, Math.max(1, Math.ceil(mins))), actions, seconds: 90, urgent: true,
                }, {chime: 'important', why: L(`họp lúc ${at}`, `meeting at ${at}`)});
                return;
            }
        }
        const m = this._currentMeeting(now);
        if (m) {
            if (this._once(`in-meeting-${m.id}`, now)) {
                const until = timeString(m.end);
                this.diary.add('meeting', L(`Đang họp “${m.title}” tới ${until} — pet giữ im lặng`,
                    `In “${m.title}” until ${until} — the pet stays quiet`), {now});
            }
            return;
        }
        if (this.focusSession)
            return;

        if (!this.hasToken) {
            // The hello shortly after start counts as the first ask. A keyring that cannot be read is not "no token".
            if (this._askTokenAt === null && !this._tokenUnread && this._every('token', 60, now)) {
                this._askForToken();
                this.lastRule = 'token';
            }
            return;
        }
        const ctx = this._context(now);
        const target = this.target;

        if (this.awaySince !== null) {
            const minutes = Math.trunc((now - this.awaySince) / MINUTE);
            this.awaySince = null;
            this.diary.add('system', L(`Bạn quay lại sau ${minutes} phút`, `You came back after ${minutes} minutes`), {now});
            const next = this.day.next;
            if (minutes > 15 && ctx.inWork && next) {
                this._remind('welcome', {
                    text: Lines.welcomeBack(next), actions: [this._focusAction(next), this._laterAction()], seconds: 30,
                }, {why: L(`bạn vừa quay lại sau ${minutes} phút`, `you just came back after ${minutes} minutes`)});
                return;
            }
        }

        // 1. Tasks with an exact time: 10 minutes before, and when due.
        for (const t of this.day.open) {
            const time = t.dueTime;
            if (!time)
                continue;
            const mins = (time - now) / MINUTE;
            const at = timeString(time);
            if (mins > 0 && mins <= 10 && this._once(`soon-${t.id}`, now)) {
                this._remind('due', {
                    text: Lines.soon(t, Math.ceil(mins)), actions: [this._focusAction(t), this._completeAction(t)], seconds: 40, urgent: true,
                }, {chime: 'important', why: L(`việc hẹn lúc ${at}`, `task due at ${at}`)});
                return;
            }
            if (mins <= 0 && mins > -5 && this._once(`now-${t.id}`, now)) {
                this._remind('due', {
                    text: Lines.dueNow(t), actions: [this._focusAction(t), this._completeAction(t)], seconds: 60, urgent: true,
                }, {chime: 'important', why: L(`tới giờ hẹn ${at}`, `due now (${at})`)});
                return;
            }
        }
        if (this.bubble !== null)
            return;

        // Distraction apps and sites come first: there's no concentration to protect right then.
        // Grumpy and stuck on one for 5+ minutes: the pet jumps in the way.
        const open = this.day.open.length;
        const d = this._distraction(now);
        if (this.prefs.antics && ctx.inWork && this.mood === Mood.angry && now > this.anticSnoozedUntil && open > 0 && d &&
            d.minutes >= 5 && this._every('antic', 20, now)) {
            const mins = Math.trunc(d.minutes);
            this._block(d.app, this.day.next, L(`đang cáu và ở ${d.app} ${mins} phút → nhảy lên chắn màn hình`,
                `grumpy and on ${d.app} for ${mins} min → jumped in the way`), now);
            return;
        }
        if (ctx.inWork && open > 0 && d && d.minutes >= 2 && this._every('distract', 10, now)) {
            const mins = Math.trunc(d.minutes);
            this._remind('distraction', {
                text: Lines.distraction({mood: this.mood, app: d.app, left: open, next: this.day.next}),
                actions: [
                    this._focusAction(this.day.next),
                    {
                        title: L("Nghỉ xíu thôi (10')", "Just a quick break (10')"),
                        run: () => {
                            this.distractionSnoozedUntil = new Date(this._now().getTime() + 10 * MINUTE);
                        },
                    },
                ],
                seconds: 30,
            }, {why: L(`ở ${d.app} ${mins} phút trong giờ làm`, `on ${d.app} for ${mins} min during work hours`)});
            return;
        }

        if (ctx.night && now.getHours() >= 23 && this._once(`night-${this.dayKey}`, now)) {
            this._remind('night', {text: Lines.lateNight(), seconds: 10},
                {why: L('đã quá 23 giờ mà bạn vẫn dùng máy', "past 11pm and you're still at it")});
            return;
        }

        // 2. Everything finished.
        if (this.day.completed.length > 0 && this.day.remaining === 0 && this.day.overdue.length === 0 &&
            this._once(`alldone-${this.dayKey}`, now)) {
            this.celebrateUntil = new Date(now.getTime() + 4 * SECOND);
            this.recompute(now);
            this._remind('alldone', {
                text: Lines.allDone(),
                actions: [{title: L('＋ Việc cho mai', '＋ Plan tomorrow'), run: () => this.openBoard?.(true)}],
                seconds: 20,
            }, {why: L('xong hết việc hôm nay', 'everything for today is done')});
            return;
        }

        // Calm: everything below can wait. Never during deep work, only at a natural pause (a typing break or an app
        // switch), and at most one unsolicited bubble per `bubbleGap` minutes. Held reminders are written to the
        // diary so the thresholds can be tuned.
        const day = this.day;
        const remindEvery = this._prefInt('remindEvery', 1);
        const somethingDue = ctx.inWork && (
            (day.planned < target && ctx.hoursAfterPlanDeadline >= 0 && this._isDue('plan', 30, now)) ||
            (day.next !== null && now - this.lastBubbleAt > remindEvery * MINUTE && this._isDue('nudge', remindEvery, now)) ||
            this.stuckTasks.some(s => !this.fired.has(`stuck-${s.task.id}-${this.dayKey}`)) ||
            (isHungry(this.life.state) && this._isDue('hungry', 60, now)));
        if (this.flow) {
            if (somethingDue) {
                this.diary.add('hold', L('Có lời nhắc đến hạn nhưng bạn đang vào guồng — để sau',
                    "A reminder is due but you're in the zone — later"), {throttle: 'hold-flow', every: 15, now});
            }
            return;
        }
        this.lastAppSwitch = this._lastAppSwitch();
        if (!CalmRules.atBreakpoint(this._secondsSinceKey(), (now - this.lastAppSwitch) / SECOND)) {
            if (somethingDue) {
                this.diary.add('hold', L('Hoãn nhắc vì bạn đang gõ phím — chờ bạn ngừng tay',
                    "Held a reminder: you're typing — waiting for a pause"), {throttle: 'hold-typing', every: 10, now});
            }
            return;
        }
        const gap = this._prefInt('bubbleGap', 0);
        if (!CalmRules.withinBudget(this.lastBubbleAt, now, gap)) {
            if (somethingDue) {
                const last = timeString(this.lastBubbleAt);
                this.diary.add('hold', L(`Hoãn nhắc: lần nhắc trước lúc ${last}, cần cách ít nhất ${gap} phút`,
                    `Held a reminder: last one at ${last}, at least ${gap} min apart`), {throttle: 'hold-gap', every: 10, now});
            }
            return;
        }

        if (!ctx.workday)
            return;

        // 3. Morning greeting, with planning if today has fewer than `target` tasks.
        if (ctx.inWork && this._once(`morning-${this.dayKey}`, now)) {
            const needsPlan = day.planned < target;
            if (needsPlan)
                this.fired.set('plan', now);
            let text = Lines.morning(now, day, target);
            if (this.events.length > 0) {
                const {workStart, workEnd} = this._hours();
                const start = atHour(workStart, 0, now);
                const end = atHour(workEnd, 0, now);
                const free = freeMinutes(this.events, start, end);
                text += `\n${Lines.calendarDay({
                    meetings: this.events.length,
                    busyMinutes: (end - start) / MINUTE - free,
                    freeMinutes: free,
                    target,
                    reduced: target < this._prefInt('dailyTarget', 1),
                })}`;
            }
            const life = this.life.state;
            if (life.dirt > 0)
                text += `\n${Lines.dirty(life.dirt)}`;
            if (life.streak > 0)
                text += `\n${Lines.streak(life.streak)}`;
            const next = day.next;
            this._remind('morning', {
                text,
                actions: needsPlan ? this._planActions() : (next ? [this._focusAction(next), this._laterAction()] : []),
                seconds: 60,
            }, {
                why: L('lời chào đầu ngày làm việc', 'first greeting of the workday') +
                    (needsPlan ? L(`, mới có ${day.planned}/${target} việc`, `, only ${day.planned}/${target} planned`) : ''),
            });
            return;
        }

        // 4. Not planned enough: nag every 30 minutes once the planning deadline passed.
        if (ctx.inWork && day.planned < target && ctx.hoursAfterPlanDeadline >= 0 && this._every('plan', 30, now)) {
            const deadline = this._hours().planDeadline;
            this._remind('plan', {
                text: Lines.plan({mood: this.mood, planned: day.planned, target}), actions: this._planActions(), seconds: 60,
            }, {
                why: L(`đã qua ${deadline}h mà mới có ${day.planned}/${target} việc`,
                    `past ${deadline}:00 with only ${day.planned}/${target} planned`),
            });
            return;
        }

        // 6. A task that keeps getting postponed: offer to split it (or drop it). Once per task per day.
        if (ctx.inWork) {
            const s = this.stuckTasks.find(x => !this.fired.has(`stuck-${x.task.id}-${this.dayKey}`));
            if (s && this._every('stuck', 120, now)) {
                this.fired.set(`stuck-${s.task.id}-${this.dayKey}`, now);
                const title = shortText(s.task.title, 30);
                this._remind('stuck', {
                    text: Lines.stuck(s, this.mood),
                    actions: [
                        {title: L('✂️ Chia nhỏ', '✂️ Split it'), primary: true, run: () => this.openBreakdown?.(s.task)},
                        {title: L('Bỏ khỏi kế hoạch', 'Drop from plan'), run: () => this.unplan(s.task)},
                        this._laterAction(),
                    ],
                    seconds: 60,
                }, {why: L(`“${title}” nằm trong danh sách ${s.days} ngày`, `“${title}” has been on your list ${s.days} days`)});
                return;
            }
        }

        // 6b. A hungry pet begs for a finished task.
        if (ctx.inWork && isHungry(this.life.state) && this._every('hungry', 60, now)) {
            const satiety = this.life.state.satiety;
            const next = day.next;
            this._remind('hungry', {
                text: Lines.hungry(satiety, next), actions: next ? [this._focusAction(next), this._laterAction()] : [], seconds: 30,
            }, {why: L(`độ no còn ${Math.trunc(satiety)}%`, `only ${Math.trunc(satiety)}% full`)});
            this._speak(Lines.voiceHungry());
            return;
        }

        // 6c. Mischief that escalates while you slack: grumbling, then a parade with the task on a sign.
        // Never while you're typing (that's work, even if no task got ticked off yet).
        const next = day.next;
        if (this.prefs.antics && ctx.inWork && now > this.anticSnoozedUntil && this._secondsSinceKey() > 60 && next) {
            const angry = this.angrySince;
            if (angry && now - angry >= 10 * MINUTE && this._every('antic', 20, now)) {
                const mins = Math.trunc((now - angry) / MINUTE);
                this._parade(next, L(`đã cáu ${mins} phút, không gõ phím → diễu hành với biển`,
                    `grumpy for ${mins} min, not typing → sign parade`) + this._reasonSuffix(), now);
                return;
            }
            const annoyed = this.annoyedSince;
            if (annoyed && now - annoyed >= 10 * MINUTE && this._every('grumble', 30, now)) {
                const mins = Math.trunc((now - annoyed) / MINUTE);
                this._grumble(next, L(`đã nhăn nhó ${mins} phút`, `annoyed for ${mins} min`) + this._reasonSuffix(), now);
                return;
            }
        }

        // 7. Overdue tasks.
        if (ctx.inWork && day.overdue.length > 0 && this._every('overdue', 90, now)) {
            const n = day.overdue.length;
            this._remind('overdue', {
                text: Lines.overdue(this.mood, n),
                actions: [
                    {title: L('Dời vào hôm nay', 'Move to today'), primary: true, run: () => this.pullOverdueToToday()},
                    {title: L('Xem', 'Show'), run: () => this.openBoard?.(false)},
                ],
                seconds: 45,
            }, {why: L(`${n} việc quá hạn (nhắc tối đa 90 phút/lần)`, `${n} overdue task(s) (at most every 90 min)`)});
            return;
        }

        // 8. Give the next task a concrete time slot (implementation intention), once a day.
        const slot = this.suggestions[0];
        if (ctx.inWork && day.planned >= target && slot && slot.start - now < 3 * HOUR && this._once(`timeblock-${this.dayKey}`, now)) {
            this._remind('timeblock', {
                text: Lines.timeBlock(slot),
                actions: [
                    {title: L('⏰ Đặt giờ', '⏰ Set time'), primary: true, run: () => this.schedule(slot)},
                    this._laterAction(),
                ],
                seconds: 60,
            }, {why: L('gợi ý khung giờ trống (mỗi ngày một lần)', 'a free time slot (once a day)')});
            return;
        }

        // 9. End-of-day review (shutdown ritual).
        if (ctx.inWork && now >= ctx.reviewTime && day.remaining > 0 && this._once(`review-${this.dayKey}`, now)) {
            this._remind('review', {
                text: Lines.review({completed: day.completed.length, planned: day.planned, remaining: day.remaining}),
                actions: [
                    {title: L('Dời sang mai', 'Move to tomorrow'), primary: true, run: () => this.moveTodayToTomorrow()},
                    {title: L('Làm tiếp', 'Keep going')},
                ],
                seconds: 90,
            }, {why: L(`30 phút trước giờ tan làm, còn ${day.remaining} việc`, `30 min before work ends, ${day.remaining} left`)});
            return;
        }

        // 9b. A sulky end-of-day report on time spent in distracting apps and sites.
        const distracted = distractionTotal(this.life.state);
        if (ctx.inWork && now >= ctx.reviewTime && distracted >= 10 * 60 && this._once(`distractsum-${this.dayKey}`, now)) {
            const mins = Math.trunc(distracted / 60);
            this._remind('distractsum', {text: Lines.distractionSummary(this.life.state.distraction), seconds: 25},
                {why: L(`cuối ngày, xao nhãng ${mins} phút`, `end of day, ${mins} min of distractions`)});
            this._speak(Lines.voiceSummary(mins));
            return;
        }

        // 10. Regular nudge with the next task.
        if (ctx.inWork && next && now - this.lastBubbleAt > remindEvery * MINUTE && this._every('nudge', remindEvery, now)) {
            const idleHours = (now - this._lastProgress(now)) / HOUR;
            const idle = idleHours.toFixed(1);
            this._remind('nudge', {
                text: Lines.nudge({mood: this.mood, next, hoursIdle: idleHours}),
                actions: [this._focusAction(next), this._completeAction(next), this._laterAction()],
                seconds: 45,
            }, {
                why: L(`${remindEvery} phút chưa nhắc; ${idle} giờ chưa có tiến triển`,
                    `${remindEvery} min since the last reminder; no progress for ${idle}h`),
            });
            return;
        }

        // 11. A tip now and then, only when the mood is good.
        if (ctx.inWork && (this.mood === Mood.happy || this.mood === Mood.normal) && now - this.lastBubbleAt > 40 * MINUTE &&
            this._every('tip', 150, now)) {
            this._remind('tip', {text: Lines.tip(), seconds: 14},
                {why: L('pet đang vui và đã im lặng 40 phút', 'the pet is in a good mood and quiet for 40 min')});
        }
    }

    // Shows a rule's bubble and remembers which rule spoke.
    _remind(rule, bubble, options) {
        this.say(bubble, options);
        this.lastRule = rule;
    }

    // Without setting it: has `key` not fired for `minutes`?
    _isDue(key, minutes, now = this._now()) {
        const last = this.fired.get(key);
        return last === undefined || now - last >= minutes * MINUTE;
    }

    // " (−30 only 1/3 planned; −10 no progress…)": the top reasons behind the current mood.
    _reasonSuffix() {
        const r = this.reasons.filter(x => x.delta < 0).slice(0, 2).map(x => `${x.delta} ${x.text}`).join('; ');
        return r === '' ? '' : ` (${r})`;
    }

    _planActions() {
        const actions = [{title: L('＋ Thêm việc', '＋ Add tasks'), primary: true, run: () => this.openBoard?.(true)}];
        const movable = this.day.overdue.filter(t => !t.isRecurring);
        if (movable.length > 0) {
            actions.push({
                title: L(`Kéo ${movable.length} việc quá hạn vào`, `Pull ${movable.length} overdue in`),
                run: () => this.pullOverdueToToday(),
            });
        }
        actions.push(this._laterAction());
        return actions;
    }

    _focusAction(task) {
        const minutes = this._prefInt('focusMinutes', 1);
        return {
            title: `▶︎ ${L(`Tập trung ${minutes}'`, `Focus ${minutes}'`)}`,
            primary: true,
            run: () => this.startFocus(task),
        };
    }

    // Puts the nudge off: it is due again `minutes` from now.
    _laterAction(minutes = 30) {
        return {
            title: L('Để sau', 'Later'),
            run: () => {
                const offset = (minutes - this._prefInt('remindEvery', 1)) * MINUTE;
                this.fired.set('nudge', new Date(this._now().getTime() + offset));
            },
        };
    }

    _completeAction(task) {
        return {title: L('✓ Xong rồi', '✓ Done'), run: () => this.complete(task)};
    }

    // Calls the pet off: no mischief and no distraction reminders for 15 minutes.
    _spareAction() {
        return {
            title: L("Tha cho tôi 15'", "Spare me 15'"),
            run: () => {
                const until = new Date(this._now().getTime() + 15 * MINUTE);
                this.anticSnoozedUntil = until;
                this.distractionSnoozedUntil = until;
                this.endAntic();
            },
        };
    }

    // --- The stunts (the three antic branches of Swift's runRules) ---
    // Each one starts the antic for the pet window, says its bubble (with "Spare me 15'") with the grumble chime,
    // writes the diary line with `why`, and says its voice line when the voice is on.

    // Sighs and stomps about `next`, the task nobody touched.
    _grumble(next, why, now) {
        this._startAntic('grumble', next.title, now);
        this._remind('antic', {
            text: Lines.grumble(next), actions: [this._focusAction(next), this._spareAction()], seconds: 15,
        }, {chime: 'grumble', why, antic: true});
        this._speak(Lines.voiceGrumble());
    }

    // Marches across the screen with `next` on a sign.
    _parade(next, why, now) {
        this._startAntic('parade', next.title, now);
        this._remind('antic', {
            text: Lines.parade(next), actions: [this._focusAction(next), this._spareAction()], seconds: 25, urgent: true,
        }, {chime: 'grumble', why, antic: true});
        this._speak(Lines.voiceAngry(next));
    }

    // Jumps into the middle of the screen and flips the table at `app` (the distracting app or site); `next` (or
    // null) is what to do instead.
    _block(app, next, why, now) {
        this._startAntic('block', app, now);
        this._remind('antic', {
            text: Lines.block(app, next), actions: [this._focusAction(next), this._spareAction()], seconds: 25, urgent: true,
        }, {chime: 'grumble', why, antic: true});
        this._speak(Lines.voiceBlock(app));
    }

    // Plays a stunt now, whatever the rules say: the dev scenes and the Developer page (Swift's TODOPET_ANTIC hook).
    // `kind` is 'grumble', 'parade' or 'block'. The grumble and the parade are about the next task; with none, the
    // antic alone plays, about "Demo", as in Swift's hook. The block is about the distracting app or site in front,
    // else youtube.com. The diary says it was a test; the rules' own timing is left alone.
    devAntic(kind, now = this._now()) {
        const why = L('thử từ chế độ nhà phát triển', 'a developer test');
        const next = this.day.next;
        if (kind === 'block') {
            this._block(this._currentDistraction(now)?.app ?? 'youtube.com', next, why, now);
        } else if (kind === 'grumble' || kind === 'parade') {
            if (!next)
                this._startAntic(kind, 'Demo', now);
            else if (kind === 'grumble')
                this._grumble(next, why, now);
            else
                this._parade(next, why, now);
        } else {
            throw new Error(`devAntic: unknown antic '${kind}'`);
        }
    }

    // Starts a stunt for the pet window: `text` is what it is about (the task on the parade's sign, the task the pet
    // grumbles about, the site it blocks).
    _startAntic(kind, text, now) {
        this._anticSeq += 1;
        this.antic = {id: `antic-${this._anticSeq}`, kind, text, start: now};
        this.emit('antic', this.antic);
        this._changed();
    }

    _lastAppSwitch() {
        try {
            const at = this.env.lastAppSwitch();
            return at instanceof Date ? at : this.lastAppSwitch;
        } catch (e) {
            this._log(`TodoPet: could not read the last app switch: ${e?.message ?? e}`);
            return this.lastAppSwitch;
        }
    }

    _openURL(url) {
        try {
            this.env.openURL(url);
        } catch (e) {
            this._log(`TodoPet: could not open ${url}: ${e?.message ?? e}`);
        }
    }
}

// Adds the methods above to `cls.prototype` (non-enumerable, like class methods). A name the class already has is
// a mistake, so it throws instead of replacing it.
export function installRules(cls) {
    const descriptors = Object.getOwnPropertyDescriptors(RuleMethods.prototype);
    for (const [name, descriptor] of Object.entries(descriptors)) {
        if (name === 'constructor')
            continue;
        if (Object.hasOwn(cls.prototype, name))
            throw new Error(`brain/rules.js: ${cls.name} already has ${name}`);
        Object.defineProperty(cls.prototype, name, descriptor);
    }
}
