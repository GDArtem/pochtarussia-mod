// Почта России v2 — система запросов поставок между игроками
// Блок: Пусковая установка (3x3)
// Механика: запрос → уведомление получателю → принять/отклонить → юнит летит

const COOLDOWN_SECONDS = 30;
const MAX_ITEMS = 500;
const UNIT_SPEED = 2.0;
const UNLOAD_PORTION = 5;    // предметов за одну порцию выгрузки
const UNLOAD_INTERVAL = 6;   // тиков между порциями

const DELIVER_ITEMS = [
    Items.copper, Items.lead, Items.graphite, Items.coal,
    Items.titanium, Items.thorium, Items.silicon,
    Items.plastanium, Items.phaseFabric, Items.surgeAlloy
];

// ── Состояние ─────────────────────────────────────────────────────
// ВАЖНО: JS-скрипт мода выполняется НЕЗАВИСИМО на сервере и на каждом
// клиенте — свой Rhino-контекст, своя память. Обычные переменные верхнего
// уровня НЕ синхронизируются по сети сами по себе. pendingRequests поэтому
// хранится только как источник правды НА СЕРВЕРЕ (см. блок "Сеть" ниже);
// клиент не читает/не пишет её напрямую, а общается с сервером через
// Call.clientPacketReliable(...) / Call.serverPacketReliable(...) —
// это встроенный generic RPC-канал Mindustry (NetClient.java/NetServer.java,
// @Remote(targets = Loc.server) и @Remote(targets = Loc.client)),
// предназначенный именно для модов/плагинов.
let activeDeliveries = [];   // летящие юниты (сервер применяет ко всем через спавн юнита - синхронизируется движком автоматически)
let pendingRequests = [];    // ожидающие подтверждения запросы — актуальны ТОЛЬКО на сервере
let buttonCooldown = 0;
let selectedItem = DELIVER_ITEMS[0];
let selectedAmount = 100;
let nextRequestId = 1;

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
    unit.addItem(item, Math.min(actual, unit.type.itemCapacity));

    activeDeliveries.push({
        unit: unit,
        toLauncher: toLauncher,
        item: item,
        amount: actual,
        unloading: false,
        unloadTimer: 0
    });

    Vars.ui.announce(
        "[cyan]Почта России[] отправила посылку!\n" +
        "[yellow]" + actual + "x " + getItemName(item) + "[] летит к союзнику!",
        4
    );
}

// ── Апдейт полётов ────────────────────────────────────────────────
// spawnDelivery() и updateDeliveries() трогают авторитетное состояние игры
// (unit.add(), core.items.remove/add) — это должно выполняться ТОЛЬКО на
// сервере (или в одиночной игре без сети). Юнит и его перемещение затем
// сами реплицируются клиентам штатным механизмом синка сущностей движка
// (entitySnapshot/blockSnapshot), т.е. отдельно синхронизировать unit.vel
// вручную клиенту не нужно — он получит уже актуальную позицию по сети.
//
// Юнит везёт груз на себе (unit.stack, единственный ItemStack — ItemsComp)
// и, долетев, не исчезает мгновенно: он останавливается у пусковой
// установки и постепенно выгружает груз в её items порциями (dumpAccumulate
// затем сам отдаёт предметы на подключённый конвейер, если он есть —
// подтверждено по BuildingComp.java, тег v158.1). Ресурсы больше не
// телепортируются напрямую в ядро получателя.

function updateDeliveries() {
    if (!isHostAuthority()) return;
    activeDeliveries = activeDeliveries.filter(d => {
        if (!d.unit || !d.unit.isValid() || !d.unit.isAlive()) return false;

        const target = d.toLauncher;
        if (!target || !target.isValid()) {
            d.unit.kill();
            return false;
        }

        if (!d.unloading) {
            const dx = target.x - d.unit.x;
            const dy = target.y - d.unit.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 24) {
                d.unit.vel.setZero();
                d.unloading = true;
                Vars.ui.announce(
                    "[green]Почта России[] прибыла, выгружает посылку...",
                    2
                );
                return true;
            }

            d.unit.vel.set((dx / dist) * UNIT_SPEED, (dy / dist) * UNIT_SPEED);
            d.unit.rotation = Mathf.angle(dx, dy);
            d.unit.shield = 99999;
            return true;
        }

        // ── Фаза выгрузки: переносим груз из юнита в блок порциями ────
        if (!d.unit.hasItem() || d.unit.stack.amount <= 0) {
            d.unit.kill();
            Vars.ui.announce(
                "[green]Почта России[] доставила посылку!\n" +
                "[yellow]" + d.amount + "x " + getItemName(d.item) + "[] получено!",
                4
            );
            return false;
        }

        d.unloadTimer++;
        if (d.unloadTimer >= UNLOAD_INTERVAL) {
            d.unloadTimer = 0;
            const space = target.block.itemCapacity - target.items.get(d.item);
            const portion = Math.min(UNLOAD_PORTION, d.unit.stack.amount, Math.max(space, 0));
            if (portion > 0) {
                d.unit.stack.amount -= portion;
                target.items.add(d.item, portion);
            }
            target.dumpAccumulate(d.item);
        }
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

        // НЕ пишем в pendingRequests локально — это не будет видно другим
        // машинам. Вместо этого шлём запрос серверу (единый источник правды),
        // а сервер сам решит, кому и что показать.
        sendRequestToServer(selectedTeam.id, selectedItem.name, selectedAmount);

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

// ── Обработка входящих запросов (диалог у ПОЛУЧАТЕЛЯ) ─────────────
// Вызывается только из onServerRequest(...) в сетевом блоке ниже, то есть
// только после того как СЕРВЕР явно адресовал этот конкретный запрос
// именно этому клиенту через Call.serverPacketReliable(player, ...).
// Локально из pendingRequests сюда больше никто не попадает.

function showIncomingRequestDialog(req) {
    const myTeam = Vars.player.team();
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

    const btnTable = dialog.cont.table().get();

    btnTable.button("[green]Принять", () => {
        sendResponseToServer(req.id, true);
        dialog.hide();
    }).width(120).height(50).pad(6);

    btnTable.button("[red]Отклонить", () => {
        sendResponseToServer(req.id, false);
        Vars.ui.announce("[red]Запрос от " + senderName + " отклонён.", 3);
        dialog.hide();
    }).width(120).height(50).pad(6);

    dialog.show();
}

// ── Сеть: сервер — единый источник правды ──────────────────────────
// Используем встроенный generic packet API Mindustry вместо самодельного
// @Remote (для JS-мода это самый простой путь — не требует Java/аннотаций):
//   Call.clientPacketReliable(type, contents)                — клиент → сервер
//   Call.serverPacketReliable(player, type, contents)         — сервер → 1 клиент
//   Vars.netClient.addPacketHandler(type, contents => ...)    — приём на клиенте
//   Vars.netServer.addPacketHandler(type, (player, contents) => ...) — приём на сервере
// Payload — строка, поэтому гоняем JSON.stringify/JSON.parse.
// Источники: core/src/mindustry/core/NetClient.java, NetServer.java (Anuken/Mindustry).

const PACKET_REQUEST = "pochta-request";   // клиент → сервер: новый запрос поставки
const PACKET_RESPONSE = "pochta-response"; // клиент → сервер: ответ (принять/отклонить)
const PACKET_INCOMING = "pochta-incoming"; // сервер → клиент: покажи диалог входящего запроса
const PACKET_RESULT = "pochta-result";     // сервер → клиент: итог (одобрено/отклонено/просрочено)

function sendRequestToServer(toTeamId, itemName, amount) {
    Call.clientPacketReliable(PACKET_REQUEST, JSON.stringify({
        toTeamId: toTeamId,
        item: itemName,
        amount: amount
    }));
}

function sendResponseToServer(requestId, accepted) {
    Call.clientPacketReliable(PACKET_RESPONSE, JSON.stringify({
        id: requestId,
        accepted: accepted
    }));
}

// ── Сеть: обработчики НА СЕРВЕРЕ ────────────────────────────────────
// pendingRequests живёт только здесь. isServer() гарантирует, что этот
// код не пытается что-то делать на клиентах (там netServer недоступен
// в актуальном виде и Vars.net.server() === false).

function isHostAuthority() {
    // Одиночная игра/локальный хост без активной сети — тоже считается
    // "сервером" (авторитетом), просто с одним игроком.
    return !Vars.net.active() || Vars.net.server();
}

if (Vars.net.server() || !Vars.net.active()) {
    Events.on(EventType.ServerLoadEvent, () => registerServerHandlers());
    // На случай если сервер уже поднят к моменту загрузки скрипта (headless старт)
    registerServerHandlers();
}

let serverHandlersRegistered = false;
function registerServerHandlers() {
    if (serverHandlersRegistered) return;
    if (!Vars.netServer) return;
    serverHandlersRegistered = true;

    Vars.netServer.addPacketHandler(PACKET_REQUEST, (player, contents) => {
        const data = JSON.parse(contents);
        const toTeam = Team.get(data.toTeamId);
        const fromTeam = player.team();

        const fromLaunchers = getLaunchersOfTeam(fromTeam);
        const toLaunchers = getLaunchersOfTeam(toTeam);
        if (fromLaunchers.length === 0 || toLaunchers.length === 0) return;

        const item = Vars.content.item(data.item);
        if (!item) return;

        const req = {
            id: nextRequestId++,
            fromTeam: fromTeam,
            toTeam: toTeam,
            item: item,
            amount: data.amount,
            fromLauncher: fromLaunchers[0],
            toLauncher: toLaunchers[0],
            timer: 30 * 60
        };
        pendingRequests.push(req);

        // Находим игрока(ов) команды-получателя и адресуем ИМЕННО им
        Groups.player.each(p => {
            if (p.team() && p.team().id === toTeam.id) {
                Call.serverPacketReliable(p.con, PACKET_INCOMING, JSON.stringify({
                    id: req.id,
                    fromTeamId: fromTeam.id,
                    item: item.name,
                    amount: req.amount
                }));
            }
        });
    });

    Vars.netServer.addPacketHandler(PACKET_RESPONSE, (player, contents) => {
        const data = JSON.parse(contents);
        const idx = pendingRequests.findIndex(r => r.id === data.id);
        if (idx === -1) return;
        const req = pendingRequests[idx];

        // Только адресат запроса может на него отвечать
        if (!player.team() || player.team().id !== req.toTeam.id) return;

        pendingRequests.splice(idx, 1);

        if (data.accepted) {
            const fromLauncher = getLaunchersOfTeam(req.toTeam)[0];
            if (fromLauncher) {
                spawnDelivery(fromLauncher, req.fromLauncher, req.item, req.amount, req.toTeam);
            }
        }
        // При желании: разослать PACKET_RESULT инициатору запроса,
        // чтобы показать "отклонено"/"принято" именно ему.
    });
}

function tickServerRequests() {
    if (!isHostAuthority()) return;
    pendingRequests = pendingRequests.filter(req => {
        req.timer--;
        return req.timer > 0;
    });
}

// ── Сеть: обработчик НА КЛИЕНТЕ ─────────────────────────────────────
// Клиент просто ждёт, пока сервер САМ решит адресовать ему конкретный
// запрос, и показывает диалог. Никакого локального pendingRequests тут
// не требуется.

let clientHandlersRegistered = false;
function registerClientHandlers() {
    if (clientHandlersRegistered) return;
    if (!Vars.netClient) return;
    clientHandlersRegistered = true;

    Vars.netClient.addPacketHandler(PACKET_INCOMING, contents => {
        const data = JSON.parse(contents);
        showIncomingRequestDialog({
            id: data.id,
            fromTeam: Team.get(data.fromTeamId),
            item: Vars.content.item(data.item),
            amount: data.amount
        });
    });
}

Events.on(EventType.ClientLoadEvent, () => {
    registerClientHandlers();
});

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
    tickServerRequests();
});
