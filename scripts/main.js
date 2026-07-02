// Почта России v2 — система запросов поставок между игроками
// Блок: Пусковая установка (3x3)
// Механика: запрос → уведомление получателю → принять/отклонить → юнит летит

const COOLDOWN_SECONDS = 30;
const MAX_ITEMS = 500;
const UNIT_SPEED = 2.0;

const DELIVER_ITEMS = [
    Items.copper, Items.lead, Items.graphite, Items.coal,
    Items.titanium, Items.thorium, Items.silicon,
    Items.plastanium, Items.phaseFabric, Items.surgeAlloy
];

// ── Состояние ─────────────────────────────────────────────────────
let activeDeliveries = [];   // летящие юниты
let pendingRequests = [];    // ожидающие подтверждения запросы
let buttonCooldown = 0;
let selectedItem = DELIVER_ITEMS[0];
let selectedAmount = 100;

// ── Хелперы ───────────────────────────────────────────────────────

function getItemName(item) {
    return item.localizedName || item.name;
}

function getPochtaType() {
    let found = null;
    Vars.content.units().each(u => {
        if (String(u.name).indexOf("pochta-carrier") !== -1) found = u;
    });
    return found;
}

// Найти все пусковые установки команды
function getLaunchersOfTeam(team) {
    const launchers = [];
    const blockType = Vars.content.block("pochta-rossii-postal-launcher");
    if (!blockType) return launchers;
    Groups.build.each(b => {
        if (b.team === team && b.block === blockType && b.isValid()) {
            launchers.push(b);
        }
    });
    return launchers;
}

// Все команды игроков (не derelict, не crux если AI)
function getPlayerTeams() {
    const teams = [];
    Groups.player.each(p => {
        if (p.team() && p.team() !== Team.derelict) {
            let already = false;
            for (let i = 0; i < teams.length; i++) {
                if (teams[i].id === p.team().id) { already = true; break; }
            }
            if (!already) teams.push(p.team());
        }
    });
    return teams;
}

function getTeamName(team) {
    // Ищем имя игрока из этой команды
    let name = "Команда " + team.id;
    Groups.player.each(p => {
        if (p.team() && p.team().id === team.id) {
            name = p.name || name;
        }
    });
    return name;
}

// ── Спавн юнита доставки ──────────────────────────────────────────

function spawnDelivery(fromLauncher, toLauncher, item, amount, fromTeam) {
    const pochtaType = getPochtaType();
    if (!pochtaType) {
        Vars.ui.showInfo("[red]Ошибка: юнит Почты России не найден!");
        return;
    }

    // Снять ресурсы с ядра отправителя
    const senderCore = fromTeam.core();
    if (!senderCore) return;
    const actual = Math.min(amount, senderCore.items.get(item));
    if (actual <= 0) {
        Vars.ui.showInfo("[red]Нет ресурсов для отправки!");
        return;
    }
    senderCore.items.remove(item, actual);

    const unit = pochtaType.create(fromTeam);
    unit.set(fromLauncher.x, fromLauncher.y);
    unit.add();

    activeDeliveries.push({
        unit: unit,
        toLauncher: toLauncher,
        item: item,
        amount: actual,
        delivered: false
    });

    Vars.ui.announce(
        "[cyan]Почта России[] отправила посылку!\n" +
        "[yellow]" + actual + "x " + getItemName(item) + "[] летит к союзнику!",
        4
    );
}

// ── Апдейт полётов ────────────────────────────────────────────────

function updateDeliveries() {
    activeDeliveries = activeDeliveries.filter(d => {
        if (!d.unit || !d.unit.isValid() || !d.unit.isAlive()) return false;
        if (d.delivered) return false;

        const target = d.toLauncher;
        if (!target || !target.isValid()) {
            d.unit.kill();
            return false;
        }

        const dx = target.x - d.unit.x;
        const dy = target.y - d.unit.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 24) {
            // Доставлено — кладём ресурсы в ядро получателя
            const receiverCore = target.team.core();
            if (receiverCore) {
                const space = receiverCore.storageCapacity - receiverCore.items.get(d.item);
                receiverCore.items.add(d.item, Math.min(d.amount, space));
            }
            d.unit.kill();
            d.delivered = true;
            Vars.ui.announce(
                "[green]Почта России[] доставила посылку!\n" +
                "[yellow]" + d.amount + "x " + getItemName(d.item) + "[] получено!",
                4
            );
            return false;
        }

        d.unit.vel.set((dx / dist) * UNIT_SPEED, (dy / dist) * UNIT_SPEED);
        d.unit.rotation = Mathf.angle(dx, dy);
        d.unit.shield = 99999;
        return true;
    });
}

// ── Диалог запроса поставки ───────────────────────────────────────

function showRequestDialog() {
    const myTeam = Vars.player.team();
    const myLaunchers = getLaunchersOfTeam(myTeam);

    if (myLaunchers.length === 0) {
        Vars.ui.showInfo("[red]Сначала постройте Пусковую установку Почты России!");
        return;
    }

    const otherTeams = getPlayerTeams().filter(t => t.id !== myTeam.id);
    if (otherTeams.length === 0) {
        Vars.ui.showInfo("[red]Нет других игроков в игре!");
        return;
    }

    const dialog = new BaseDialog("Почта России — Запрос поставки");
    dialog.cont.defaults().pad(6);
    dialog.cont.add("[cyan]От кого запросить ресурсы?").row();

    // Список игроков
    let selectedTeam = otherTeams[0];
    const teamTable = dialog.cont.table().get();
    teamTable.defaults().pad(4);

    let selectedTeamBtn = null;
    otherTeams.forEach(team => {
        const tname = getTeamName(team);
        const btn = teamTable.button(tname, () => {
            selectedTeam = team;
            if (selectedTeamBtn) selectedTeamBtn.setChecked(false);
            selectedTeamBtn = btn;
            btn.setChecked(true);
        }).width(180).height(40).get();
        if (team.id === selectedTeam.id) {
            btn.setChecked(true);
            selectedTeamBtn = btn;
        }
    });
    dialog.cont.row();
    dialog.cont.add("[lightgray]Выбери ресурс:").left().row();

    // Ресурсы
    const itemTable = dialog.cont.table().get();
    itemTable.defaults().pad(3);
    let selectedBtn = null;

    DELIVER_ITEMS.forEach(item => {
        const btn = itemTable.button(
            new TextureRegionDrawable(item.uiIcon),
            Styles.clearTogglei,
            () => {
                selectedItem = item;
                if (selectedBtn) selectedBtn.setChecked(false);
                selectedBtn = btn;
                btn.setChecked(true);
            }
        ).size(48, 48).get();
        if (item === selectedItem) {
            btn.setChecked(true);
            selectedBtn = btn;
        }
    });

    dialog.cont.row();
    dialog.cont.add("[lightgray]Количество:").left().row();
    const amountLabel = dialog.cont.label(() => "[yellow]" + selectedAmount).get();

    const slider = new Slider(1, MAX_ITEMS, 1, false);
    slider.setValue(selectedAmount);
    slider.changed(() => { selectedAmount = Math.floor(slider.getValue()); });
    dialog.cont.add(slider).width(260).row();

    const quickTable = dialog.cont.table().get();
    [50, 100, 200, 500].forEach(n => {
        quickTable.button("" + n, () => { slider.setValue(n); selectedAmount = n; }).width(60).pad(4);
    });
    dialog.cont.row();

    dialog.cont.button("[cyan]Отправить запрос!", () => {
        const theirLaunchers = getLaunchersOfTeam(selectedTeam);
        if (theirLaunchers.length === 0) {
            Vars.ui.showInfo("[red]У " + getTeamName(selectedTeam) + " нет Пусковой установки!");
            return;
        }

        // Добавляем запрос в очередь — получатель увидит уведомление
        pendingRequests.push({
            fromTeam: myTeam,
            toTeam: selectedTeam,
            item: selectedItem,
            amount: selectedAmount,
            fromLauncher: myLaunchers[0],
            toLauncher: theirLaunchers[0],
            timer: 30 * 60  // 30 секунд на ответ
        });

        buttonCooldown = COOLDOWN_SECONDS * 60;
        Vars.ui.announce(
            "[cyan]Запрос отправлен игроку [yellow]" + getTeamName(selectedTeam) + "[]!\n" +
            "Ожидаем ответа...",
            4
        );
        dialog.hide();
    }).width(240).height(50).pad(6).row();

    dialog.addCloseButton();
    dialog.show();
}

// ── Обработка входящих запросов ───────────────────────────────────

let shownRequests = new Set();

function checkIncomingRequests() {
    const myTeam = Vars.player.team();

    pendingRequests.forEach((req, idx) => {
        if (req.toTeam.id !== myTeam.id) return;
        if (shownRequests.has(idx)) return;
        shownRequests.add(idx);

        // Показываем диалог подтверждения
        const senderName = getTeamName(req.fromTeam);
        const dialog = new BaseDialog("Почта России — Входящий запрос");
        dialog.cont.defaults().pad(8);
        dialog.cont.add(
            "[cyan]" + senderName + "[] просит поставить:\n" +
            "[yellow]" + req.amount + "x " + getItemName(req.item) + "[]"
        ).row();

        const myCore = myTeam.core();
        const available = myCore ? myCore.items.get(req.item) : 0;
        dialog.cont.add("[lightgray]У вас есть: [white]" + available + "[]").row();

        // Кнопки
        const btnTable = dialog.cont.table().get();

        btnTable.button("[green]Принять", () => {
            // Найти установки
            const fromLauncher = getLaunchersOfTeam(myTeam)[0];
            if (!fromLauncher) {
                Vars.ui.showInfo("[red]Нет вашей Пусковой установки!");
                dialog.hide();
                return;
            }
            spawnDelivery(fromLauncher, req.fromLauncher, req.item, req.amount, myTeam);
            pendingRequests.splice(idx, 1);
            shownRequests.delete(idx);
            dialog.hide();
        }).width(120).height(50).pad(6);

        btnTable.button("[red]Отклонить", () => {
            Vars.ui.announce("[red]Запрос от " + senderName + " отклонён.", 3);
            pendingRequests.splice(idx, 1);
            shownRequests.delete(idx);
            dialog.hide();
        }).width(120).height(50).pad(6);

        dialog.show();
    });

    // Убираем просроченные запросы
    pendingRequests = pendingRequests.filter((req, idx) => {
        req.timer--;
        if (req.timer <= 0) {
            shownRequests.delete(idx);
            return false;
        }
        return true;
    });
}

// ── Дерево технологий ────────────────────────────────────────────
// Регистрация узла TechTree теперь делается декларативно через поле
// "research" в blocks/postal-launcher.json — парсер контента (ContentParser.java)
// сам создаёт TechNode и подвешивает его к родителю по имени. Ручной JS-код
// здесь был не нужен и содержал баг: у TechNode есть поле "content", а не
// "block", поэтому TechTree.all.find(n => n.block === Blocks.coreShard) всегда
// возвращал undefined, if-блок не выполнялся, и нода никогда не создавалась —
// без единой ошибки в логе.

// ── HUD кнопка ────────────────────────────────────────────────────

Events.on(EventType.ClientLoadEvent, () => {
    const table = new Table(Styles.black3);
    table.bottom().left();

    const btn = table.button("[cyan]Запросить поставку", () => {
        if (buttonCooldown > 0) {
            Vars.ui.showInfo("[red]Кулдаун: " + Math.ceil(buttonCooldown / 60) + " сек.");
            return;
        }
        showRequestDialog();
    }).size(220, 40).pad(8).get();

    btn.update(() => {
        if (!Vars.state.isGame()) return;
        if (buttonCooldown > 0) {
            buttonCooldown--;
            btn.setText("[gray]" + Math.ceil(buttonCooldown / 60) + " сек.");
        } else {
            btn.setText("[cyan]Запросить поставку");
        }
    });

    Vars.ui.hudGroup.addChild(table);
});

// ── Главный тик ───────────────────────────────────────────────────

Events.run(Trigger.update, () => {
    if (!Vars.state.isGame()) return;
    updateDeliveries();
    checkIncomingRequests();
});
