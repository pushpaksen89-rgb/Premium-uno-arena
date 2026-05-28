const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    }
}));

let rooms = {}; 
const MASTER_ADMIN_PASS = "ADMIN_GOD_MODE"; 

function generateUnoDeck() {
    const colors = ['Red', 'Blue', 'Yellow', 'Green'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    let deck = [];
    for (let color of colors) {
        for (let val of values) {
            deck.push({ color: color, value: val });
            if (val !== '0') deck.push({ color: color, value: val });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'Wild', value: 'Wild' });
        deck.push({ color: 'Wild', value: 'Draw4' });
        deck.push({ color: 'Wild', value: 'WildSwap' });
    }
    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function findRoomByPlayerId(playerId) {
    for (let roomId in rooms) {
        if (rooms[roomId].players.some(p => p.id === playerId)) return rooms[roomId];
    }
    return null;
}

function moveToNextTurn(room) {
    let attempts = 0;
    const activePlayers = room.players.filter(p => !p.isSpectator && !p.finished);
    if(activePlayers.length === 0) return;
    
    do {
        if (room.direction === 1) {
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
        } else {
            room.currentTurn = (room.currentTurn - 1 + room.players.length) % room.players.length;
        }
        attempts++;
    } while ((room.players[room.currentTurn].isSpectator || room.players[room.currentTurn].finished) && attempts < room.players.length);
}

function isValidUnoMove(card, topCard, activeWildColor) {
    if (card.color === 'Wild') return true; 
    if (activeWildColor && card.color === activeWildColor) return true;
    if (!activeWildColor && card.color === topCard.color) return true;
    if (card.value === topCard.value) return true;
    return false;
}

function broadcastGameState(room) {
    const currentTurnPlayer = room.players[room.currentTurn] || { name: "None", id: "" };

    room.players.forEach((p) => {
        let allHandsSnapshot = null;
        if (p.isAdmin) {
            allHandsSnapshot = room.players.map(pl => ({
                id: pl.id,
                name: pl.name,
                hand: pl.hand,
                finished: pl.finished,
                isSpectator: pl.isSpectator
            }));
        }

        io.to(p.id).emit('gameStateUpdate', {
            yourHand: p.hand,
            topCard: room.discardPile[room.discardPile.length - 1] || null,
            activeWildColor: room.activeWildColor,
            isYourTurn: (currentTurnPlayer.id === p.id && !p.isSpectator && !p.finished),
            isSpectator: p.isSpectator,
            currentTurnName: currentTurnPlayer.name,
            playerListSnapshot: room.players.map(pl => ({
                name: pl.name,
                count: pl.hand.length,
                active: (currentTurnPlayer.id === pl.id),
                finished: pl.finished,
                isSpectator: pl.isSpectator
            })),
            allPlayersHandsSnapshot: allHandsSnapshot
        });
    });
}

io.on('connection', (socket) => {
    
    socket.on('joinGame', (data) => {
        let roomId = data.room || "Arena_1";
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId, players: [], deck: [], discardPile: [],
                currentTurn: 0, direction: 1, isStarted: false, activeWildColor: null, standings: [],
                pendingDrawnPlayableCard: null 
            };
        }
        const room = rooms[roomId];
        
        const newPlayer = {
            id: socket.id, 
            name: data.username || `User_${socket.id.slice(0,4)}`,
            hand: [], 
            isAdmin: (data.password === MASTER_ADMIN_PASS), 
            finished: false, 
            isSpectator: room.isStarted,
            hasDeclaredUno: false // Track if safe from penalties
        };
        
        room.players.push(newPlayer);
        socket.join(roomId);
        io.to(roomId).emit('systemNotification', `${newPlayer.name} entered room ${roomId}`);
        io.to(roomId).emit('updatePlayers', room.players);
        broadcastGameState(room);
    });

    socket.on('textMessageSignal', (msg) => {
        const room = findRoomByPlayerId(socket.id);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if(player) io.to(room.id).emit('incomingTextMessage', { user: player.name, text: msg });
    });

    socket.on('startGameSignal', () => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        
        room.deck = generateUnoDeck();
        room.discardPile = [];
        room.isStarted = true;
        room.direction = 1;
        room.activeWildColor = null;
        room.standings = [];
        room.pendingDrawnPlayableCard = null;

        room.players.forEach(p => {
            p.hand = []; 
            p.finished = false;
            p.isSpectator = false; 
            p.hasDeclaredUno = false;
            for(let i=0; i<7; i++) {
                if(room.deck.length > 0) p.hand.push(room.deck.pop());
            }
        });

        let startingCard = room.deck.pop();
        while(startingCard && startingCard.color === 'Wild') {
            room.deck.unshift(startingCard);
            startingCard = room.deck.pop();
        }
        if(startingCard) room.discardPile.push(startingCard);
        
        room.currentTurn = room.players.findIndex(p => !p.isSpectator);
        io.to(room.id).emit('systemNotification', "⚡ Match Matrix fully synchronized! Rules fully loaded.");
        broadcastGameState(room);
    });

    socket.on('drawCardRequest', () => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || !room.isStarted || room.players[room.currentTurn].id !== socket.id) return;
        if(room.pendingDrawnPlayableCard) return;

        const player = room.players[room.currentTurn];

        if(room.deck.length === 0) {
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [top];
        }

        const drawnCard = room.deck.pop();
        player.hand.push(drawnCard);
        
        // Drawing a card resets the UNO call requirement state safely
        player.hasDeclaredUno = false;

        const topCard = room.discardPile[room.discardPile.length - 1];
        
        if (isValidUnoMove(drawnCard, topCard, room.activeWildColor)) {
            room.pendingDrawnPlayableCard = { playerIndex: room.currentTurn, cardIndex: player.hand.length - 1 };
            io.to(player.id).emit('systemNotification', `💡 You drew a playable [${drawnCard.color} ${drawnCard.value}]! Click it now to play, or click the deck again to pass your turn.`);
            broadcastGameState(room);
        } else {
            io.to(room.id).emit('systemNotification', `🎴 ${player.name} drew a card and passed.`);
            moveToNextTurn(room);
            broadcastGameState(room);
        }
    });

    socket.on('playCardRequest', (data) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || !room.isStarted || room.players[room.currentTurn].id !== socket.id) return;

        const player = room.players[room.currentTurn];
        const card = player.hand[data.index];
        if(!card) return;

        const topCard = room.discardPile[room.discardPile.length - 1];

        if (room.pendingDrawnPlayableCard) {
            if (data.index !== room.pendingDrawnPlayableCard.cardIndex) {
                return socket.emit('errorAlert', "Rule Violation: You must play the exact card you just drew, or click the deck to pass!");
            }
        } else {
            if (!isValidUnoMove(card, topCard, room.activeWildColor)) {
                return socket.emit('errorAlert', `Illegal Play! Card must match ${room.activeWildColor || topCard.color} or value ${topCard.value}.`);
            }
        }

        // Execute action placement
        player.hand.splice(data.index, 1);
        room.discardPile.push(card);
        
        // Clear wild focus if playing a regular matching colored asset
        if (card.color !== 'Wild') {
            room.activeWildColor = null;
        } else if (data.chosenColor) {
            room.activeWildColor = data.chosenColor; 
        }

        room.pendingDrawnPlayableCard = null;

        // Apply standard actions modifications
        if (card.value === 'Skip') moveToNextTurn(room);
        if (card.value === 'Reverse') room.direction *= -1;
        
        if (card.value === 'Draw2') {
            moveToNextTurn(room);
            const target = room.players[room.currentTurn];
            for(let i=0; i<2; i++) if(room.deck.length > 0) target.hand.push(room.deck.pop());
            target.hasDeclaredUno = false;
            io.to(room.id).emit('systemNotification', `🎯 ${target.name} hit by Draw 2 penalty!`);
        }
        
        if (card.value === 'Draw4') {
            moveToNextTurn(room);
            const target = room.players[room.currentTurn];
            for(let i=0; i<4; i++) if(room.deck.length > 0) target.hand.push(room.deck.pop());
            target.hasDeclaredUno = false;
            io.to(room.id).emit('systemNotification', `💥 ${target.name} hit by absolute Draw 4 penalty!`);
        }

        // --- ENFORCED STRICT 1-CARD UNO RULE CHECKER ---
        if (player.hand.length === 1 && !player.hasDeclaredUno) {
            // Player forgot to press "SHOUT UNO!" before dropped card went through
            for(let i=0; i<2; i++) if(room.deck.length > 0) player.hand.push(room.deck.pop());
            io.to(room.id).emit('systemNotification', `🚨 Penalty! ${player.name} failed to call UNO and was penalized +2 cards.`);
        }

        if (player.hand.length === 0 && !player.finished) {
            player.finished = true;
            room.standings.push(player.name);
            io.to(room.id).emit('celebrateWinner', { winnerName: player.name, standings: room.standings });
        }

        moveToNextTurn(room);
        broadcastGameState(room);
    });

    socket.on('passTurnAfterDraw', () => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || room.players[room.currentTurn].id !== socket.id) return;
        if (room.pendingDrawnPlayableCard) {
            room.pendingDrawnPlayableCard = null;
            io.to(room.id).emit('systemNotification', `⏭️ Player passed turn after choosing not to drop drawn item.`);
            moveToNextTurn(room);
            broadcastGameState(room);
        }
    });

    socket.on('declareUnoSignal', () => {
        const room = findRoomByPlayerId(socket.id);
        if(room) {
            const player = room.players.find(p => p.id === socket.id);
            if(player) {
                player.hasDeclaredUno = true;
                io.to(room.id).emit('systemNotification', `📢 ${player.name} safely shouted UNO!`);
            }
        }
    });

    // --- LOCKED DOWN VALIDATED ADMIN CONFIGS ---
    socket.on('adminAddCustomCard', (data) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        const executor = room.players.find(p => p.id === socket.id);
        if (!executor || !executor.isAdmin) return;

        const target = room.players.find(p => p.id === data.targetId);
        if(target) {
            let customColor = data.color;
            let customValue = data.value;

            // Restrict Wild properties explicitly to ensure authentic layouts
            if (customValue === 'Wild' || customValue === 'Draw4' || customValue === 'WildSwap') {
                customColor = 'Wild';
            } else if (customColor === 'Wild') {
                // If admin picks color 'Wild' but a number value, override it safely to a standard color
                customColor = 'Red';
            }

            target.isSpectator = false;
            target.hand.push({ color: customColor, value: customValue });
            target.hasDeclaredUno = false; // Reset safe status on inject updates
            io.to(room.id).emit('systemNotification', `⚡ Admin generated authentic [${customColor} ${customValue}] into ${target.name}'s system.`);
            broadcastGameState(room);
        }
    });

    socket.on('adminClearCards', (targetId) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        const executor = room.players.find(p => p.id === socket.id);
        if (!executor || !executor.isAdmin) return;

        const target = room.players.find(p => p.id === targetId);
        if(target) {
            target.hand = [];
            target.finished = true;
            room.standings.push(target.name);
            io.to(room.id).emit('celebrateWinner', { winnerName: target.name, standings: room.standings });
            moveToNextTurn(room);
            broadcastGameState(room);
        }
    });

    socket.on('voice-join', () => {
        const room = findRoomByPlayerId(socket.id);
        if (room) socket.to(room.id).emit('voice-peer-joined', socket.id);
    });
    socket.on('voice-signal', (data) => {
        io.to(data.to).emit('voice-signal', { signal: data.signal, from: socket.id });
    });
    socket.on('disconnect', () => {
        const room = findRoomByPlayerId(socket.id);
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(room.id).emit('updatePlayers', room.players);
            broadcastGameState(room);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enforced Rule Matrix Engine listening on port ${PORT}`));