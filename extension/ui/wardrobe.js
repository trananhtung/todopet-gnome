// The wardrobe (port of WardrobeView in LifeViews.swift): the pet's stats, the sticker book of perfect days, and the
// accessories with what each one takes to unlock and a Wear / Take off button for the ones that are. Shown by the
// board in place of the task list (the "👗 Wardrobe" button of the life bar).
//
//   build(app, onBack) -> St.Widget    onBack() returns to the task list
//
// The widget carries dispose() (called before it is destroyed; it stops the preview's redraw timer) and `view`, the
// WardrobeView with the parts the dev scenes use. What it shows comes from wardrobeModel() (ui/viewsLogic.js).
// Wearing something changes the pet's life through brain.life.toggle(); the brain does not know, so this view
// announces it with the brain's 'changed' event (the pet repaints, the board redraws).
import Clutter from 'gi://Clutter';

import {L} from '../core/l10n.js';
import {ACCESSORIES} from '../core/life.js';
import {wardrobeModel} from './viewsLogic.js';
import {MiniPet, PageShell, box, divider, iconButton, label, pillButton, spacer, wrapLabel} from './widgets.js';

const LOCKED_OPACITY = 77; // Swift: .opacity(0.3)

export class WardrobeView {
    constructor(app, onBack) {
        this._app = app;
        this._brain = app.brain;
        this._onBack = onBack;
        this._disposed = false;
        this._failed = false;
        this._sig = null;
        this._model = null;
        this._stats = [];
        this._rows = [];

        const column = box({vertical: true, styleClass: 'todopet-page todopet-page-wardrobe'});
        this._shell = new PageShell(column, {scroll: true});
        this.actor = this._shell.actor;
        this._build(column);
        this._brainId = this._brain?.on('changed', () => this._guard(() => this._update())) ?? 0;
        this._update(false);
        this._pet.start();
    }

    // --- For the dev scenes ---

    get backButton() {
        return this._back;
    }

    get model() {
        return this._model;
    }

    get rows() {
        return this._rows;
    }

    get petActor() {
        return this._pet.actor;
    }

    get stickerLabels() {
        return {title: this._stickerTitle, stars: this._stars, empty: this._stickerEmpty};
    }

    get tooltipLabel() {
        return this._shell.tooltips.label;
    }

    get statLabels() {
        return this._stats;
    }

    dispose() {
        this._disposed = true;
        if (this._brainId !== 0)
            this._brain?.off(this._brainId);
        this._brainId = 0;
        this._pet.stop();
        this._shell.dispose();
    }

    // --- Building ---

    _build(column) {
        const header = box({styleClass: 'todopet-page-header'});
        this._back = iconButton('go-previous-symbolic', () => this._onBack(), {accessibleName: L('Quay lại', 'Back')});
        header.add_child(this._back);
        this._title = label('', 'todopet-headline');
        header.add_child(this._title);
        column.add_child(header);

        // The pet, as it looks now, and the stats beside it.
        const top = box({styleClass: 'todopet-wardrobe-top'});
        this._pet = new MiniPet({intervalMs: 100, styleClass: 'todopet-wardrobe-pet'});
        top.add_child(this._pet.actor);
        const stats = box({vertical: true, styleClass: 'todopet-stats', y_align: Clutter.ActorAlign.CENTER});
        for (let i = 0; i < 5; i++) {
            const line = box({styleClass: 'todopet-stat'});
            const parts = {
                icon: label('', 'todopet-caption'),
                name: label('', 'todopet-caption todopet-secondary'),
                value: label('', 'todopet-caption todopet-bold'),
            };
            for (const part of Object.values(parts))
                line.add_child(part);
            stats.add_child(line);
            this._stats.push(parts);
        }
        top.add_child(stats);
        column.add_child(top);

        const stickers = box({vertical: true, styleClass: 'todopet-stickers'});
        this._stickerTitle = label('', 'todopet-caption todopet-bold todopet-secondary', {x_align: Clutter.ActorAlign.START});
        this._stickerEmpty = wrapLabel('', 'todopet-caption todopet-secondary');
        this._stars = label('', 'todopet-stars', {x_align: Clutter.ActorAlign.START, reactive: true});
        this._shell.tooltips.attach(this._stars, () => this._model?.stickers.days);
        stickers.add_child(this._stickerTitle);
        stickers.add_child(this._stickerEmpty);
        stickers.add_child(this._stars);
        column.add_child(stickers);
        column.add_child(divider());

        // The accessories: one row each, in the order of ACCESSORIES.
        const list = box({vertical: true, styleClass: 'todopet-accessories'});
        for (let i = 0; i < ACCESSORIES.length; i++) {
            const row = box({styleClass: 'todopet-accessory'});
            const emoji = label('', 'todopet-accessory-emoji');
            const text = box({vertical: true, styleClass: 'todopet-accessory-text', y_align: Clutter.ActorAlign.CENTER});
            const name = label('', 'todopet-accessory-name', {x_align: Clutter.ActorAlign.START});
            const status = label('', 'todopet-accessory-status todopet-secondary', {x_align: Clutter.ActorAlign.START});
            text.add_child(name);
            text.add_child(status);
            const button = pillButton('', () => this._toggle(i));
            row.add_child(emoji);
            row.add_child(text);
            row.add_child(spacer());
            row.add_child(button);
            list.add_child(row);
            this._rows.push({row, emoji, name, status, button, id: null});
        }
        column.add_child(list);
    }

    // --- State ---

    _update(relayout = true) {
        if (this._disposed || !this._brain)
            return;
        const m = wardrobeModel(this._brain.life.state, this._brain.mood);
        const sig = JSON.stringify(m);
        if (sig === this._sig)
            return;
        this._sig = sig;
        this._model = m;

        this._title.text = m.title;
        this._pet.update(m.previewMood, this._brain.life.state);
        m.stats.forEach((stat, i) => {
            const parts = this._stats[i];
            parts.icon.text = stat.icon;
            parts.name.text = `${stat.label}:`;
            parts.value.text = stat.value;
        });
        this._stickerTitle.text = m.stickers.title;
        this._stickerEmpty.visible = m.stickers.empty !== null;
        this._stickerEmpty.text = m.stickers.empty ?? '';
        this._stars.visible = m.stickers.stars !== '';
        this._stars.text = m.stickers.stars;
        m.accessories.forEach((a, i) => {
            const parts = this._rows[i];
            parts.id = a.id;
            parts.emoji.text = a.emoji;
            parts.emoji.opacity = a.owned ? 255 : LOCKED_OPACITY;
            parts.name.text = a.name;
            parts.name.style_class = `todopet-accessory-name${a.owned ? '' : ' todopet-secondary'}`;
            parts.status.text = a.status;
            parts.button.visible = a.button !== null;
            if (a.button) {
                parts.button.set_label(a.button.label);
                parts.button.style_class = `todopet-pill${a.button.primary ? ' todopet-pill-primary' : ''}`;
            }
        });
        if (relayout)
            this._app.board?.relayout();
    }

    // Wear or take off the accessory of row `index`.
    _toggle(index) {
        const brain = this._brain;
        const id = this._rows[index]?.id;
        if (!brain || !id)
            return;
        brain.life.toggle(id);
        brain.emit('changed');
        this._update();
    }

    _guard(fn) {
        try {
            fn();
        } catch (e) {
            if (!this._failed)
                console.error(`TodoPet: the wardrobe failed: ${e?.stack ?? e}`);
            this._failed = true;
        }
    }
}

// The board's page builder.
export function build(app, onBack) {
    const view = new WardrobeView(app, onBack);
    const actor = view.actor;
    actor.view = view;
    actor.dispose = () => view.dispose();
    return actor;
}
