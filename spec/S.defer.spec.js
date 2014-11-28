describe("S.defer", function () {
    describe("with diamond dependencies", function () {
        var d, f1, f2, f3, f4, f5;

        beforeEach(function () {
            //         d
            //         |
            // +---+---+---+---+
            // v   v   v   v   v
            // f1  f2  f3  f4  f5
            // |   |   |   |   |
            // +---+---+---+---+
            //         |
            //      (defer)
            //         |
            //         v
            //         g
            d = S(0);

            f1 = S.formula(function () { return d(); });
            f2 = S.formula(function () { return d(); });
            f3 = S.formula(function () { return d(); });
            f4 = S.formula(function () { return d(); });
            f5 = S.formula(function () { return d(); });

            spy = jasmine.createSpy("callCounter");

            g = S.defer().S(function () { spy(); f1(); f2(); f3(); f4(); f5(); });
        });

        iit("can avoid duplicated updates", function () {
            spy.calls.reset();
            d(0);
            expect(spy.calls.count()).toBe(1);
        });
    });
});