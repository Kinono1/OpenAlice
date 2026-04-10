from __future__ import annotations

import copy
from collections import deque
from dataclasses import dataclass
from random import random, randrange, sample

import numpy as np

from .quantile_net import build_quantile_network, require_torch


@dataclass
class Transition:
    state: np.ndarray
    action: int
    reward: float
    next_state: np.ndarray
    done: bool


class ReplayBuffer:
    def __init__(self, capacity: int = 10000):
        self.items = deque(maxlen=capacity)

    def push(self, transition: Transition):
        self.items.append(transition)

    def sample(self, batch_size: int):
        return sample(self.items, min(batch_size, len(self.items)))

    def __len__(self):
        return len(self.items)


class AlphaQCMAgent:
    def __init__(self, state_dim: int, action_dim: int, lr: float = 5e-4, gamma: float = 0.99):
        torch, _ = require_torch()
        self.torch = torch
        self.quantile_net, self.num_quantiles = build_quantile_network(state_dim, action_dim)
        self.target_net = copy.deepcopy(self.quantile_net)
        self.optimizer = torch.optim.Adam(self.quantile_net.parameters(), lr=lr)
        self.replay_buffer = ReplayBuffer()
        self.action_dim = action_dim
        self.gamma = gamma

    def select_action(
        self,
        state: np.ndarray,
        epsilon: float = 0.1,
        valid_actions: list[int] | None = None,
    ) -> int:
        action_pool = valid_actions if valid_actions else list(range(self.action_dim))
        if not action_pool:
            return 0
        if random() < epsilon:
            return action_pool[randrange(len(action_pool))]
        with self.torch.no_grad():
            tensor_state = self.torch.tensor(state, dtype=self.torch.float32).unsqueeze(0)
            tau = self.torch.rand((1, 1))
            q_values = self.quantile_net(tensor_state, tau)
            valid_q_values = q_values[:, action_pool]
            best_index = int(valid_q_values.argmax(dim=1).item())
            return int(action_pool[best_index])

    def update(self, batch_size: int = 16) -> float:
        if len(self.replay_buffer) < batch_size:
            return 0.0

        batch = self.replay_buffer.sample(batch_size)
        states = self.torch.tensor(np.vstack([item.state for item in batch]), dtype=self.torch.float32)
        actions = self.torch.tensor([item.action for item in batch], dtype=self.torch.long)
        rewards = self.torch.tensor([item.reward for item in batch], dtype=self.torch.float32)
        next_states = self.torch.tensor(np.vstack([item.next_state for item in batch]), dtype=self.torch.float32)
        dones = self.torch.tensor([item.done for item in batch], dtype=self.torch.float32)

        tau = self.torch.rand((len(batch), 1))
        next_tau = self.torch.rand((len(batch), 1))

        current_q = self.quantile_net(states, tau).gather(1, actions.unsqueeze(1)).squeeze(1)
        with self.torch.no_grad():
            next_q = self.target_net(next_states, next_tau).max(dim=1).values
            targets = rewards + self.gamma * next_q * (1 - dones)

        td_error = targets - current_q
        loss = (td_error.pow(2) * (tau.squeeze(1) - (td_error.detach() < 0).float()).abs()).mean()

        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()
        return float(loss.item())

    def sync_target(self):
        self.target_net.load_state_dict(self.quantile_net.state_dict())
