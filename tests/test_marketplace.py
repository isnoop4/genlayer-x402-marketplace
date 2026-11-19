"""Direct-mode tests for Gen402 (no server, no network).

Run:  ../.venv/bin/python -m pytest tests/test_marketplace.py -v
Web + LLM calls are mocked by gltest's VMContext.

IMPORTANT gltest quirk: VMContext.activate() evicts every module loaded
from the GenVM SDK cache when the block exits, so the contract must be
deployed AND exercised inside ONE `with vm.activate():` block per test.
Deploying in a fixture and calling methods in a second activate() block
silently breaks vm.value / vm.sender refresh and lazy `gl.nondet` imports.
"""
import json
from pathlib import Path

import pytest
from gltest.direct import VMContext, deploy_contract, create_test_addresses

CONTRACT = Path(__file__).resolve().parent.parent / "contracts" / "marketplace.py"
BTC_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
ONE_GEN = 10 ** 18


@pytest.fixture()
def env():
    vm = VMContext()
    seller, buyer, other = create_test_addresses(3)
    return vm, seller, buyer, other


def _deploy(vm, seller):
    vm.sender = seller
    return deploy_contract(CONTRACT, vm)


def _create(contract, sender, vm, model=0, price=ONE_GEN, url=BTC_URL):
    vm.sender = sender
    return contract.create_listing(
        "BTC Price Snapshot",
        "Live Bitcoin price in USD from the CoinGecko public API.",
        url, model, price,
    )


def _mock_match(vm):
    vm.mock_web(r".*coingecko.*", {"status": 200, "body": '{"bitcoin":{"usd":97432}}'})
    vm.mock_llm(r".*", json.dumps({
        "verdict": "MATCH", "confidence": 92,
        "reason": "Source returns a live BTC/USD price matching the listing.",
    }))


def test_create_and_list(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        lid = _create(contract, seller, vm)
        assert lid == 1
        assert contract.listing_count() == 1
        listings = json.loads(contract.list_listings())
        assert listings[0]["title"] == "BTC Price Snapshot"
        assert listings[0]["model"] == 0
        assert contract.get_listing(1) != ""


def test_create_listing_validation(env):
    vm, seller, *_ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        with pytest.raises(Exception):
            contract.create_listing("x", "too short title", BTC_URL, 0, ONE_GEN)
        with pytest.raises(Exception):
            contract.create_listing("Valid Title", "Valid description here.", "ftp://bad", 0, ONE_GEN)
        with pytest.raises(Exception):
            contract.create_listing("Valid Title", "Valid description here.", BTC_URL, 9, ONE_GEN)


def test_buy_access_paywall(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm)
        vm.sender = buyer
        vm.value = ONE_GEN
        assert contract.buy_access(1) == "ok"
        assert contract.has_access(buyer, 1) is True
        assert contract.seller_balance(seller) == ONE_GEN
        # second purchase of a paywall listing must fail
        vm.value = ONE_GEN
        with pytest.raises(Exception):
            contract.buy_access(1)


def test_buy_credits_and_use_call(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm, model=1, price=ONE_GEN // 10)
        vm.sender = buyer
        vm.value = ONE_GEN  # 10 credits at 0.1 GEN each
        assert contract.buy_credits(1, 10) == "ok"
        assert json.loads(contract.get_access(buyer, 1))["calls_left"] == 10
        # buyer records a call
        assert contract.use_call(1, buyer) == 9
        # owner is the gateway by default, so the seller (deployer) can record too
        assert contract.use_call(1, buyer) == 8


def test_subscription_bundle(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm, model=2, price=2 * ONE_GEN)
        vm.sender = buyer
        vm.value = 2 * ONE_GEN
        assert contract.buy_access(1) == "ok"
        assert json.loads(contract.get_access(buyer, 1))["calls_left"] == 30
        assert contract.has_access(buyer, 1) is True


def test_verify_delivery_match(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm)
        _mock_match(vm)
        vm.sender = buyer
        assert contract.verify_delivery(1) == "MATCH"
        verdict = json.loads(contract.get_verdict(1))
        assert verdict["verdict"] == "MATCH"
        assert verdict["confidence"] == 92
        # the captured validator re-runs the leader task with the same mocks
        assert vm.run_validator() is True


def test_refund_after_mismatch(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm)
        vm.sender = buyer
        vm.value = ONE_GEN
        contract.buy_access(1)
        vm.mock_web(r".*coingecko.*", {"status": 200, "body": '{"error": "not found"}'})
        vm.mock_llm(r".*", json.dumps({
            "verdict": "MISMATCH", "confidence": 88,
            "reason": "Source is an error payload, not a BTC price.",
        }))
        assert contract.verify_delivery(1) == "MISMATCH"
        # refund is only possible before the seller withdraws
        assert contract.request_refund(1) == ONE_GEN
        assert contract.has_access(buyer, 1) is False
        assert contract.seller_balance(seller) == 0


def test_refund_blocked_when_verdict_is_match(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm)
        vm.sender = buyer
        vm.value = ONE_GEN
        contract.buy_access(1)
        _mock_match(vm)
        contract.verify_delivery(1)
        with pytest.raises(Exception):
            contract.request_refund(1)


def test_withdraw_pays_seller(env):
    vm, seller, buyer, _ = env
    with vm.activate():
        contract = _deploy(vm, seller)
        _create(contract, seller, vm)
        vm.sender = buyer
        vm.value = ONE_GEN
        contract.buy_access(1)
        assert contract.seller_balance(seller) == ONE_GEN
        vm.sender = seller
        vm.value = 0
        assert contract.withdraw() == ONE_GEN
        assert contract.seller_balance(seller) == 0
        with pytest.raises(Exception):
            contract.withdraw()
