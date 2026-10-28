// The settings window as data (port of SettingsView.swift). prefs.js turns this into libadwaita pages; the pure parts
// live here so plain gjs can test them: the pages and their rows with Swift's ranges and Vietnamese, the work-hour
// limits, and what a key press means in the shortcut capture dialog. Imports only core/ files.
//
//   settingsPages() -> [{name, icon, title, groups: [{title, description, rows: [row]}]}]    built per call, in the
//                      current language (a group's description is Swift's caption: the note for the rows below it)
//   PAGE_NAMES      the English page titles, which are the pages' `name`s (dev-trigger `prefs:<name>` shows one)
//   rowCount(page)  the rows of a page
//   developerTriggers() -> [{value, title}]    the commands the Developer page's buttons write to `dev-trigger`
//   hourLimits(which, {workStart, workEnd}) -> [min, max]    Swift's steppers for the three work hours
//   joinLinksStatus(available) -> {title, subtitle}
//   hourText(h), percentText(scale), captureStep({key, accel, valid}), captureMessage(reason)
//
// A row is {kind, ...}:
//   combo      key, title, subtitle?, choices: [{value, label}]     a string setting out of a fixed list
//   entry      key, title, enabledBy?                               a string setting (enabledBy: a switch's key)
//   switch     key, title, subtitle?, needs?, unavailable?          a boolean setting (needs: 'speech', else `unavailable` says why it is off)
//   spin       key, title, subtitle?, min, max, step, hours?, limits?, enabledBy?    an integer setting
//   scale      key, title, min, max, step                           the pet's size (a double, shown as a percentage)
//   secret     secret, title, status+button | entry+titleSaved     the Todoist token and the Claude key (keyring): the
//                                                                  "saved" row with its Remove button, and the entry
//   link       title, uri                                           opens a web page
//   action     id, title, button, showWhen?                         a button: voiceTest, diaryFolder
//   shortcut   key, title                                           the board hotkey with its capture dialog
//   status     id, title                                            read-only: the Join-link status
//   trigger    value, title                                         writes `dev-trigger`
import {L} from './l10n.js';

export const PAGE_NAMES = Object.freeze([
    'General', 'Day', 'Todoist', 'Distractions', 'Calendar', 'Postponed', 'Diary', 'Shortcut', 'Developer',
]);

export const TODOIST_TOKEN_URL = 'https://app.todoist.com/app/settings/integrations/developer';
export const ANTHROPIC_KEYS_URL = 'https://console.anthropic.com/settings/keys';
export const SPEECH_TEST_LINE = ['Ê! Làm việc đi chứ!', 'Hey! Get to work!'];

const row = (kind, fields) => ({kind, ...fields});
const group = (title, description, rows) => ({title, description, rows});

const minutes = () => L('phút', 'minutes');

// Everything the `dev-trigger` buttons play, in the order of the Developer page (ui/devTrigger.js parses them).
export function developerTriggers() {
    return [
        {value: 'parade', title: L('Diễu hành với biển', 'Sign parade')},
        {value: 'block', title: L('Đứng chắn màn hình', 'Stand in the way')},
        {value: 'grumble', title: L('Càu nhàu', 'Grumble')},
        {value: 'celebrate:jump', title: L('Ăn mừng: nhảy', 'Celebrate: jump')},
        {value: 'celebrate:spin', title: L('Ăn mừng: xoay vòng', 'Celebrate: spin')},
        {value: 'celebrate:flip', title: L('Ăn mừng: lộn nhào', 'Celebrate: flip')},
        {value: 'celebrate:dance', title: L('Ăn mừng: nhảy múa', 'Celebrate: dance')},
        {value: 'celebrate:fireworks', title: L('Ăn mừng: pháo hoa', 'Celebrate: fireworks')},
        {value: 'golden', title: L('Món thưởng vàng', 'Golden treat')},
        {value: 'bubble', title: L('Bong bóng thử', 'Test bubble')},
    ];
}

export function settingsPages() {
    return [
        {
            name: 'General', icon: 'preferences-system-symbolic', title: L('Chung', 'General'),
            groups: [
                group('', '', [
                    row('combo', {
                        key: 'lang', title: L('Ngôn ngữ', 'Language'),
                        choices: [
                            {value: '', label: L('Theo hệ thống', 'System default')},
                            {value: 'en', label: 'English'},
                            {value: 'vi', label: 'Tiếng Việt'},
                        ],
                    }),
                    row('entry', {key: 'pet-name', title: L('Tên pet', 'Pet name')}),
                    row('scale', {key: 'pet-scale', title: L('Kích thước', 'Size'), min: 0.7, max: 1.6, step: 0.1}),
                ]),
                group('', L('“Chỉ khi quan trọng”: kêu khi sắp họp, việc tới giờ, hết phiên tập trung và lúc ăn mừng xong việc; bong bóng thường im lặng.',
                    '“Important only”: chimes for meetings, tasks due now, the end of a focus session and finished tasks; ordinary bubbles stay silent.'), [
                    row('combo', {
                        key: 'sound-mode', title: L('Âm thanh', 'Sounds'),
                        choices: [
                            {value: 'off', label: L('Tắt', 'Off')},
                            {value: 'important', label: L('Chỉ khi quan trọng', 'Important only')},
                            {value: 'all', label: L('Tất cả', 'Everything')},
                        ],
                    }),
                ]),
                group('', '', [
                    row('switch', {
                        key: 'chase-when-angry',
                        title: L('Khi nổi cáu thì đuổi theo con trỏ chuột', 'Chase the mouse cursor when grumpy'),
                    }),
                    row('switch', {
                        key: 'antics', title: L('Quậy khi bạn lười', 'Mischief when you slack'),
                        subtitle: L('Càu nhàu, diễu hành với biển, đứng chắn màn hình', 'Grumbling, sign parade, standing in the way'),
                    }),
                    row('switch', {
                        key: 'voice-on', title: L('Pet nói thành tiếng', 'Pet speaks out loud'),
                        subtitle: L('Dùng giọng đọc của hệ thống (spd-say)', 'Uses the system text-to-speech voice (spd-say)'),
                        needs: 'speech',
                        unavailable: L('Cần speech-dispatcher: cài gói speech-dispatcher (lệnh spd-say) để bật', 'Needs speech-dispatcher: install the speech-dispatcher package (the spd-say command) to turn this on'),
                    }),
                    row('action', {
                        id: 'voiceTest', title: L('Nghe thử', 'Test voice'), button: L('Nói', 'Speak'), showWhen: 'voice-on',
                    }),
                ]),
            ],
        },
        {
            name: 'Day', icon: 'alarm-symbolic', title: L('Ngày làm việc', 'Day'),
            groups: [
                group(L('Nhịp làm việc', 'Work rhythm'), '', [
                    row('spin', {
                        key: 'daily-target', title: L('Số việc cần lên kế hoạch mỗi ngày', 'Tasks to plan each day'),
                        min: 1, max: 10, step: 1,
                    }),
                    row('spin', {
                        key: 'work-start', title: L('Bắt đầu làm việc', 'Work starts'),
                        min: 0, max: 23, step: 1, hours: true, limits: 'workStart',
                    }),
                    row('spin', {
                        key: 'work-end', title: L('Kết thúc', 'Work ends'),
                        min: 1, max: 24, step: 1, hours: true, limits: 'workEnd',
                    }),
                    row('spin', {
                        key: 'plan-deadline', title: L('Hạn lên kế hoạch', 'Plan by'),
                        min: 0, max: 24, step: 1, hours: true, limits: 'planDeadline',
                    }),
                    row('switch', {key: 'work-saturday', title: L('Làm việc Thứ 7', 'Work on Saturday')}),
                    row('switch', {key: 'work-sunday', title: L('Làm việc Chủ nhật', 'Work on Sunday')}),
                    row('spin', {
                        key: 'remind-every', title: L('Nhắc việc mỗi', 'Nudge every'), subtitle: minutes(),
                        min: 15, max: 180, step: 15,
                    }),
                    row('spin', {
                        key: 'focus-minutes', title: L('Phiên tập trung', 'Focus session'), subtitle: minutes(),
                        min: 5, max: 90, step: 5,
                    }),
                    row('spin', {
                        key: 'break-minutes', title: L('Nghỉ giữa phiên', 'Break'), subtitle: minutes(),
                        min: 1, max: 30, step: 1,
                    }),
                    row('switch', {
                        key: 'adapt-target',
                        title: L('Ngày nhiều họp thì giảm số việc cần làm', 'Lower the daily target on meeting-heavy days'),
                    }),
                ]),
                group(L('Không làm bạn mất tập trung', "Don't break my focus"),
                    L('Lời nhắc không gấp chỉ hiện khi bạn ngừng gõ một chút hoặc chuyển app. Nhắc họp và việc tới giờ luôn hiện đúng lúc.',
                        'Non-urgent reminders wait until you pause typing or switch apps. Meeting and due-time reminders always arrive on time.'), [
                        row('switch', {
                            key: 'protect-flow', title: L('Bảo vệ lúc đang vào guồng', 'Protect deep work'),
                            subtitle: L('Gõ phím liên tục 10 phút thì pet im lặng 🎧', 'After 10 minutes of steady typing the pet stays quiet 🎧'),
                        }),
                        row('switch', {
                            key: 'still-while-typing',
                            title: L('Pet đứng yên, cử động nhẹ khi bạn đang gõ phím', 'Pet keeps still while you type'),
                        }),
                        row('spin', {
                            key: 'bubble-gap', title: L('Cách nhau ít nhất giữa hai lời nhắc', 'At least this long between reminders'),
                            subtitle: minutes(), min: 5, max: 60, step: 5,
                        }),
                    ]),
            ],
        },
        {
            name: 'Todoist', icon: 'emblem-ok-symbolic', title: 'Todoist',
            groups: [
                group('', '', [
                    row('secret', {secret: 'todoist', status: true, title: L('Đã kết nối', 'Connected'), button: L('Ngắt kết nối', 'Disconnect')}),
                    row('secret', {
                        secret: 'todoist', entry: true, title: 'API token', titleSaved: L('Token mới (tuỳ chọn)', 'New token (optional)'),
                    }),
                    row('link', {title: L('Lấy token ↗', 'Get token ↗'), uri: TODOIST_TOKEN_URL}),
                ]),
                group('', L('Cú pháp bộ lọc Todoist, vd: (today | overdue) & #Công việc', 'Todoist filter syntax, e.g. (today | overdue) & #Work'), [
                    row('entry', {key: 'filter-query', title: L('Bộ lọc “việc của tôi hôm nay”', '“My day” filter')}),
                ]),
            ],
        },
        {
            name: 'Distractions', icon: 'dialog-warning-symbolic', title: L('Xao nhãng', 'Distractions'),
            groups: [
                group('', L('Tên app cách nhau bởi dấu phẩy. Mở app này hơn 2 phút trong giờ làm, pet sẽ cáu.',
                    'Comma-separated app names. Using one for 2+ minutes during work hours makes the pet grumpy.'), [
                    row('entry', {key: 'distraction-apps', title: L('Ứng dụng gây xao nhãng', 'Distracting apps')}),
                ]),
                group('', L('Tên miền cách nhau bởi dấu phẩy (gồm cả tên miền con), hoặc một phần địa chỉ như youtube.com/shorts. '
                    + 'Pet so khớp với tiêu đề cửa sổ trình duyệt nên chỉ gần đúng: nhận ra trang qua tên trang trong tiêu đề '
                    + '(youtube.com qua “YouTube”), còn luật có đường dẫn cần cả từ cuối của đường dẫn trong tiêu đề (“Shorts”). '
                    + 'Hỗ trợ Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Cốc Cốc. Pet không lưu lại tiêu đề.',
                'Comma-separated domains (subdomains included), or part of an address like youtube.com/shorts. '
                    + 'Sites are matched by the browser window’s title, so this is approximate: a site is recognised by its name in the title '
                    + '(youtube.com by “YouTube”), and a rule with a path needs the path’s last word in the title too (“Shorts”). '
                    + 'Works with Firefox, Chrome, Chromium, Brave, Edge, Vivaldi, Opera and Cốc Cốc. The pet never stores titles.'), [
                    row('switch', {key: 'watch-browsers', title: L('Theo dõi trang web trong trình duyệt', 'Watch websites in the browser')}),
                    row('entry', {key: 'distraction-sites', title: L('Trang web gây xao nhãng', 'Distracting websites'), enabledBy: 'watch-browsers'}),
                ]),
            ],
        },
        {
            name: 'Calendar', icon: 'x-office-calendar-symbolic', title: L('Lịch', 'Calendar'),
            groups: [group('', L('Khi đang họp pet im lặng và không tính là bạn lười. Cứ 2 giờ trống ≈ 1 việc quan trọng.',
                'During meetings the pet stays quiet and doesn\'t count it as slacking. About 1 important task per 2 free hours.'), [
                row('switch', {
                    key: 'use-calendar', title: L('Đọc Lịch của GNOME', 'Read the GNOME calendar'),
                    subtitle: L('Gồm tài khoản Google, Microsoft đã thêm trong Tài khoản trực tuyến',
                        'Includes Google and Microsoft accounts added in Online Accounts'),
                }),
                row('spin', {
                    key: 'meeting-lead', title: L('Nhắc trước giờ họp', 'Remind before meetings'), subtitle: minutes(),
                    min: 1, max: 30, step: 1, enabledBy: 'use-calendar',
                }),
                row('status', {id: 'joinLinks', title: L('Nút Join', 'Join links')}),
            ])],
        },
        {
            name: 'Postponed', icon: 'document-open-recent-symbolic', title: L('Bị dời mãi', 'Postponed'),
            groups: [
                group('', '', [
                    row('spin', {
                        key: 'stuck-days', title: L('Coi là “bị dời mãi” sau', 'Flag a task after'),
                        subtitle: L('ngày', 'days on your list'), min: 2, max: 10, step: 1,
                    }),
                ]),
                group('', L('API key dùng để gợi ý cách chia nhỏ việc. Key lưu trong GNOME Keyring. Khi bạn bấm “Nhờ Claude gợi ý”, tên và ghi chú của việc được gửi tới Claude API (tính phí theo lượt dùng, khoảng 1–2 xu Mỹ mỗi lần).',
                    'The key is used for split suggestions. It lives in GNOME Keyring. When you press “Ask Claude”, the task\'s title and notes are sent to the Claude API (billed per use, roughly 1–2 US cents each time).'), [
                    row('secret', {secret: 'claude', status: true, title: L('Đã có API key Claude', 'Claude API key saved'), button: L('Xoá key', 'Remove key')}),
                    row('secret', {
                        secret: 'claude', entry: true, title: L('API key Claude (tuỳ chọn)', 'Claude API key (optional)'),
                        titleSaved: L('API key Claude mới (tuỳ chọn)', 'New Claude API key (optional)'),
                    }),
                    row('link', {title: L('Lấy API key ↗', 'Get an API key ↗'), uri: ANTHROPIC_KEYS_URL}),
                    row('entry', {key: 'claude-model', title: L('Model Claude', 'Claude model')}),
                ]),
            ],
        },
        {
            name: 'Diary', icon: 'accessories-text-editor-symbolic', title: L('Nhật ký', 'Diary'),
            groups: [group('', '', [
                row('switch', {
                    key: 'keep-log', title: L('Ghi nhật ký pet', 'Keep the pet diary'),
                    subtitle: L('Chỉ trên máy này, giữ 14 ngày', 'This computer only, 14 days'),
                }),
                row('action', {id: 'diaryFolder', title: L('Mở thư mục nhật ký', 'Open diary folder'), button: L('Mở', 'Open')}),
            ])],
        },
        {
            name: 'Shortcut', icon: 'input-keyboard-symbolic', title: L('Phím tắt', 'Shortcut'),
            groups: [group('', L('Phím tắt toàn cục. Cần Ctrl, Alt hoặc Super đi kèm một phím. Trong hộp bắt phím: Esc để huỷ, Backspace để tắt phím tắt.',
                'A global shortcut. It needs Ctrl, Alt or Super together with a key. In the capture window, Esc cancels and Backspace turns the shortcut off.'), [
                row('shortcut', {key: 'board-hotkey', title: L('Mở bảng việc', 'Open the task board')}),
            ])],
        },
        {
            name: 'Developer', icon: 'applications-engineering-symbolic', title: L('Phát triển', 'Developer'),
            groups: [
                group('', '', [
                    row('switch', {
                        key: 'demo-mode', title: L('Chế độ demo', 'Demo mode'),
                        subtitle: L('Việc và lịch mẫu thay cho Todoist và lịch thật', 'Built-in sample tasks and events instead of Todoist and the calendar'),
                    }),
                    row('action', {id: 'diaryFolder', title: L('Mở thư mục nhật ký', 'Open diary folder'), button: L('Mở', 'Open')}),
                ]),
                group(L('Chạy ngay', 'Play now'), '', developerTriggers().map(t => row('trigger', t))),
            ],
        },
    ];
}

export const rowCount = page => page.groups.reduce((n, g) => n + g.rows.length, 0);

// The Calendar page's Join-link row once gi://ECal was tried: on when gir1.2-ecal-2.0 is installed, else it says which package.
export function joinLinksStatus(available) {
    const name = L('Nút Join', 'Join links');
    return available
        ? {title: `${name}: ${L('bật', 'on')}`, subtitle: ''}
        : {title: `${name}: ${L('tắt', 'off')}`, subtitle: L('cài gir1.2-ecal-2.0 để có nút Join', 'install gir1.2-ecal-2.0 for Join links')};
}

// --- Work hours: Swift's three steppers depend on each other ---

// Swift: workStart in 0...max(0, workEnd - 1); workEnd in (workStart + 1)...24; planDeadline in workStart...max(workStart, workEnd).
export function hourLimits(which, {workStart, workEnd}) {
    switch (which) {
    case 'workStart': return [0, Math.max(0, workEnd - 1)];
    case 'workEnd': return [workStart + 1, 24];
    case 'planDeadline': return [workStart, Math.max(workStart, workEnd)];
    default: throw new Error(`Unknown hour limits '${which}'`);
    }
}

// Swift: String(format: "%02d:00", h).
export const hourText = h => `${String(Math.trunc(h)).padStart(2, '0')}:00`;

// Swift: String(format: "%.0f%%", petScale * 100).
export const percentText = scale => `${Math.round(scale * 100)}%`;

// --- The shortcut capture dialog ---

const MODIFIER_KEY = /^(Shift|Control|Alt|Super|Meta|Hyper)_[LR]$|^(ISO_Level\d_Shift|ISO_Group_Shift|Caps_Lock|Num_Lock|Scroll_Lock|Mode_switch)$/;
const GLOBAL_MODIFIER = /<(Control|Primary|Alt|Super|Meta|Hyper)>/;

// What a key press does in the capture dialog. `key` is the key's name (Gdk.keyval_name), `accel` the accelerator
// Gtk.accelerator_name gave for it with its modifiers (`<Control><Super>t`), `valid` Gtk.accelerator_valid.
//   {action: 'cancel'}              a bare Escape
//   {action: 'clear'}               a bare Backspace: the shortcut is turned off
//   {action: 'ignore'}              a modifier held down on its own: wait for the key
//   {action: 'reject', reason}      reason 'invalid' | 'modifier' (needs Ctrl, Alt or Super)
//   {action: 'accept', accel}
export function captureStep({key, accel, valid}) {
    if (accel === 'Escape')
        return {action: 'cancel'};
    if (accel === 'BackSpace')
        return {action: 'clear'};
    if (MODIFIER_KEY.test(key))
        return {action: 'ignore'};
    if (!valid || accel === '')
        return {action: 'reject', reason: 'invalid'};
    if (!GLOBAL_MODIFIER.test(accel))
        return {action: 'reject', reason: 'modifier'};
    return {action: 'accept', accel};
}

export function captureMessage(reason) {
    return reason === 'modifier'
        ? L('Cần giữ Ctrl, Alt hoặc Super cùng với phím. Thử lại nhé.', 'Hold Ctrl, Alt or Super together with the key. Try again.')
        : L('Tổ hợp phím này không dùng được. Thử tổ hợp khác nhé.', 'That combination cannot be used. Try another one.');
}
